# V1.4 — Evidence-backed systemic diagnosis

V1.4 turns a completed development evaluation into one deterministic,
bounded Improvement Brief. It does not add an LLM judge, embedding pipeline,
or second evidence store.

```text
verified eval_run.json + run.json artifacts
  → typed grader observations
  → exact-signature failure modes
  → bounded Improvement Brief
      ├→ Builder Pi `/run` and `/traces`
      ├→ `ahde diagnose`
      └→ Evidence Explorer report
```

## Exact evidence, conservative claims

New grader results carry a hash of the normalized effective grader spec and a
typed check code. An exact grader family is identified by that pair. Two
failures with the same broad category, display name, or free-form reason are
not merged unless the exact signature matches.

A mode is `systemic` only when the exact signature fails on at least two
distinct tasks. Repeated failures on one task remain `task-local`. Legacy
grader evidence without a fingerprint is also task-local, so upgrading AHDE
cannot manufacture cross-task claims from weaker historical evidence.

The brief describes an observed mechanism and a remediation hypothesis. It
does not call grader prose a proven root cause:

- a required-tool failure proves the declared tool predicate was unsatisfied;
- an output check proves the declared output predicate was unsatisfied;
- a semantic rubric failure proves only that the configured rubric failed;
- an infrastructure error says the evidence path must be repaired and re-run.

Pass observations for the same exact signature are retained as
counter-evidence. Flakiness requires both a behavioral pass and behavioral
failure for one task; infrastructure errors never create behavioral
flakiness. Unknown infrastructure messages are never clustered across tasks.

## Stable, bounded projection

`src/application/improvement-brief.ts` owns the inference and presentation
contract. Workbench, compatibility tools, CLI, and report consume that one
module instead of independently interpreting task-level diagnosis issues.

The module:

- re-verifies the EvalRun, its member Runs, and the Diagnosis input hash;
- rejects sealed evidence before returning a Builder-visible projection;
- uses algorithm-versioned deterministic mode and brief identities;
- reports task coverage and reproduction as integer basis points;
- orders blocking and systemic modes first;
- caps emitted modes, task ids, evidence, counter-evidence, notes, and
  suggestions while recording omissions;
- applies the shared trace redactor to every displayed evidence excerpt.

An inconclusive evaluation may show behavioral observations, but its brief is
never proposal-eligible. The report reserves a representative trace for each
top mode inside its existing run budget and supports a local `#run=` deep link.

## Visibility provenance

New EvalRuns explicitly record `evidenceVisibility` and the exact ordered task
universe. Development and sealed candidate runs receive visibility from the
host-owned experiment path, never from Builder model input. Legacy
`sealed-...` labels remain a fail-closed compatibility signal.

The Improvement Brief is rebuildable derived data, not new promotion evidence.
Canonical authority remains the immutable EvalRun, Runs, traces, Diagnosis,
Proposal, Candidate, and human receipts. URLs remain local presentation only
and never enter hashes or proposal provenance.

## Deliberate next boundary

V1.4 finds and explains bounded failure modes. A later slice can make proposal
authoring select existing `failureModeId` values so the host derives proposal
diagnoses and evidence references. Semantic clustering, traffic-scale Signals,
hosted tracing, and autonomous harness mutation remain outside this milestone.
