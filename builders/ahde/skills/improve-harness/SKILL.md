---
name: improve-harness
description: Write and run the change in a bound workshop, close it into an evidence-backed exact diff, and guide a human-gated candidate application.
---

# Improve the Target harness

1. Require an approved Spec and actionable development diagnosis. Immediately
   before authoring, refresh `ahde_workbench_view` with `aspect: traces`. For a
   request such as “fix the first problem”, resolve the ordinal only against
   the returned ordered `improvementBrief.modes`; bind it to the exact
   `{ algorithmId, evalRunId, diagnosisId, briefId }` source tuple and
   `failureModeId` from that same response. Refresh and verify an explicit id
   too; never combine an id with a tuple remembered from another run.
2. Continue only when every selected mode has
   `decision: propose-harness-change` and `selectableForProposal: true`. Do not
   submit a proposal for `stabilize-and-rerun`, `repair-evidence-path`, healthy,
   inconclusive, ineligible, omitted, or unresolved modes. Explain the
   evidence-supported rerun or repair action instead.
3. Prefer changing focused Target context, skills, or declarative tools over
   adding broad orchestration or benchmark-specific phrases.
3b. **Read what was already tried first.** Call `ahde_workbench_view` with
   `aspect: "history"` (or read `priorAttempts` on `aspect: "target"`) before
   you open a workshop. Each row says what an attempt changed, which failure
   modes it aimed at, what it scored, and why it ended. If the change you were
   about to write replaces the same files for the same failure mode as an
   attempt that was rejected or came back anything but `improved`, do not write
   it: pick a different hypothesis or a different failure mode, and say in one
   sentence what is different this time. When two or three plausible
   hypotheses exist for the same problem, write them all and let the operator
   compare them — the host applies each on its own branch, screens it, verifies
   what looks promising, and shows a table with score, cost and which
   candidates are dominated. You never pick the winner.
4. **Open a workshop and work in it.** Submit `kind: workshop-open` through
   `ahde_workbench_submit`. The host opens a private copy of the exact clean
   Target revision — it is not the operator's checkout, and nothing you do in it
   changes anything until they apply a diff. Four tools exist while it is open,
   and only then:
   - `ahde_workshop_read` — read the file you are about to change, or list a
     directory, before you touch it. Never write from memory.
   - `ahde_workshop_write` — `{ path, content }` for a whole file,
     `{ path, oldText, newText }` for one exact replacement, or
     `{ path, remove: true }`. Only `AGENTS.md`, `skills/**`, `tools/**`,
     `bin/**`, `data/**` exist; the host owns `manifest.yaml` and keeps the
     declarations exact, so declare a skill, tool, or data directory by writing
     its files.
   - `ahde_workshop_bash` — one argv, no shell, inside the same OS sandbox a
     declared tool runs in. Use it to generate, inspect, or clean up files.
   - `ahde_workshop_try` — run a declared tool of that copy, including the one
     you just wrote, on one JSON input. Its setup step runs exactly as it will
     for a Target.
   Write, try, read the failure, fix, try again. Do not propose a tool you have
   not run at least once green. A try is a look, never a measurement: it is not
   evidence and never substitutes for a run.
5. **Close the workshop into the proposal.** Submit `kind: workshop-close` with
   the `source` tuple and `failureModeIds` selected above, a `summary`, and a
   `validationPlan`. The host compiles the proposal from the diff of the files
   you actually ran — you never author paths, modes, hashes, or diffs — and
   refuses a workshop that changed nothing or touched anything outside the
   scope, naming the exact paths. If you must abandon the attempt, submit
   `kind: workshop-discard`; nothing it wrote ever existed. A workshop is bound
   to one attempt and dies with it.
6. For a single-file edit you have no reason to run — one line of `AGENTS.md`,
   one `SKILL.md` — the intent path is still there and is cheaper: call
   `ahde_workbench_view` with `aspect: target` for the fresh exact-Git authoring
   index, read every resource you will fully replace through the same view with
   one returned `resourcePath`, and submit `kind: structured-proposal` with the
   exact unchanged `claim` as `authoringContext` and semantic intents only. It
   is also the only way to change the Target's execution policy. Never use
   remembered content, undeclared paths, or a resource from another revision.
7. Inspect `ahde_workbench_view` with `aspect: review`. The host renders the
   evidence references, exact changed paths and diff, risks, and validation
   plan beside your message; read them there and never retype them into chat.
   Until the operator applies it, nothing has changed: say "the diff is ready",
   never "I changed the agent" or "the tool is installed".
8. Interpret “fix”, “исправь”, or similar natural language as “prepare the
   immutable proposal and show review”, never as approval to apply. Explain the
   expected behavior change and most likely regression. When the operator then
   says apply, request `apply-proposal` with branch `candidate/<proposal run
   id>` — the host shows the exact diff and asks; when they say throw it away,
   request `discard-proposal`, which is one short question. The two outcomes
   are durable and mutually exclusive.
9. An applied change is a candidate, not a release. When the operator says
   check it, request `run-current`: it runs the exact matched experiment
   without another question. Then inspect `aspect: review` and
   `aspect: traces`. The private exam is evaluator-only and selected by the
   host.
10. When the operator says ship it, выкати, promote or release, request `ship`
   with the semantic version. One host question records the promote review,
   tags the exact checked revision, fast-forwards the operator's branch so the
   change becomes the active agent for `ahde target`, and opens the next
   round — four immutable receipts, one dialog. If any step refuses, it stops
   there and says so; nothing after it happened.
11. When the operator rejects instead, request `reject-candidate`: one short
   question, and the agent stays at its baseline. Then `continue-cycle` closes
   the round. Never describe a change that was tagged but not adopted as the
   active agent.
12. If a check was interrupted, show `aspect: review` and let the operator
   abandon it explicitly (`abandon-candidate`, one short question) before a
   retry. Never reinterpret interruption as behavioral evidence.

If evidence is inconclusive, the proposal is stale, or the diff is too large
for exact review, stop and repair the evidence/proposal instead of applying.
