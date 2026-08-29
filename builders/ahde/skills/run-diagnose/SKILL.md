---
name: run-diagnose
description: Inspect evaluation results, generate deterministic diagnosis, and connect claims to exact evidence.
---

# Run and diagnose

1. Inspect `ahde_workbench_view`; run only when its legal actions contain
   `run`. When the operator asks to run, request `run-current` through
   `ahde_workbench_decide` yourself (`/run [repetitions]` is their
   shortcut). The host confirms the exact cost and subject in its own dialog.
2. Workbench binds the approved Spec, reviewed development corpus, exact Target
   revision, dataset hash, and suite hash. Select among ambiguous artifacts
   explicitly with `ahde_workbench_submit`; never invent an id.
3. Use `/traces` or `ahde_workbench_view` with `aspect: traces` for score,
   provenance, deterministic diagnosis, and the read-only evidence link.
   Infrastructure errors make the result inconclusive and do not advance the
   Workbench stage.
4. If the operator says “fix the first problem”, “the second mode”, or names a
   `failureModeId`, call `ahde_workbench_view` with `aspect: traces` again
   before selecting anything. Slash-command output, the live widget, and prior
   chat text are not a current canonical selection. Resolve an ordinal only
   against the returned `improvementBrief.modes[*].ordinal`, and capture its
   `failureModeId` together with the top-level `algorithmId`, `evalRunId`,
   `diagnosisId`, and `briefId` from that same improvement brief. If the
   ordinal is not shown or the id is not in the current projection, stop rather
   than infer it.
5. Treat each reported failure mode as an observed family and its explanation
   as a remediation hypothesis, never as a proven root cause. Only an exact
   grader-check signature seen on at least two distinct tasks is systemic; one
   task remains task-local even when it fails repeatedly.
6. Respect the mode's evidence decision. Only
   `decision: propose-harness-change` with `selectableForProposal: true` may
   seed structured authoring. For `stabilize-and-rerun`, report instability or
   counter-evidence and recommend calibration or a rerun. For
   `repair-evidence-path`, report the evidence failure and recommend repairing
   it before rerunning. A healthy, inconclusive, proposal-ineligible, omitted,
   or unresolved mode does not authorize a proposal.
7. Report pass/total, error count, largest failure modes, affected-task
   coverage, evidence strength, counter-evidence, and the next decision the
   evidence supports. Infrastructure errors make proposals ineligible until
   the evidence path is repaired and re-run.
8. Keep large raw traces out of chat; offer the loopback Evidence Explorer link
   returned by the traces view.

Never use sealed holdout evidence to author a remediation proposal.
