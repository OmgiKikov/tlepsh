# V1.5 — Evidence-linked proposals

V1.5 closes the loop between deterministic diagnosis and structured Harness
authoring. Builder Pi may choose an observed failure mode and propose semantic
changes, but it cannot write its own diagnosis, evidence references, or causal
claim.

```text
verified EvalRun + Diagnosis
  → deterministic Improvement Brief
  → operator/Builder selects failureModeId
  → host re-verifies exact brief tuple and mode hashes
  → host derives Proposal diagnoses and run references
  → semantic intents compile to an exact diff
  → human review → Apply or Discard
```

## Model-facing contract

For diagnosis-backed improvement, `structured-proposal` accepts:

- the exact host-minted `authoringContext` claim from the fresh V1.6 Target
  view;
- the exact `{ algorithmId, evalRunId, diagnosisId, briefId }` returned by the
  current traces view;
- one to eight unique `failureModeIds` from that same brief;
- a summary, semantic Harness intents, risks, and a validation plan.

It does not accept `diagnoses`, `evidence`, `rootCause`, repository paths,
hashes, file modes, or unified diffs. Unknown, duplicate, stale, omitted,
infrastructure, unstable, legacy, healthy, and inconclusive selections fail
closed. Selected modes are canonicalized in brief order.

The same structured interface also has a construction form after Spec
approval and before the first eval. It carries the exact `authoringContext`,
approved Spec lineage, intents, risks, and validation plan, but deliberately
omits both `source` and `failureModeIds`. The host records `source: null`, no
proposal basis, and no diagnoses. Construction therefore reuses the exact
review/Apply seam without pretending product intent is failure evidence.

Natural-language ordinals are only UX sugar. For “fix the first problem”,
Builder Pi refreshes `aspect: traces`, resolves `ordinal: 1` to the current
stable id and source tuple, then prepares a proposal. “Fix” never means Apply;
Apply and Discard remain separate host-confirmed decisions.

## Authority and durable provenance

`failureModeId` is a short deterministic handle, not an authority key. The
canonical Builder service recompiles the exact Improvement Brief immediately
before recording and persists a `proposalBasis` containing:

- algorithm, EvalRun, Diagnosis, and Brief identities;
- the full Brief hash;
- every selected failure-mode id and full mode hash.

The same typed Builder input carries the host-derived diagnoses. A completed
Proposal must reproduce those diagnoses exactly, and every change must carry
exactly their canonical run references. A missing basis on a new actionable
source EvalRun, a forged diagnosis, or a mismatched evidence reference is
rejected before durable publication.

On restart and before Apply, AHDE reopens the hash-anchored source Diagnosis,
recompiles the brief, checks the full basis, and checks the Proposal again.
Historical records without a basis remain readable for compatibility; new
source-backed records cannot enter that legacy path.

The proposal review and Apply confirmation show the bounded evidence basis,
selected mode hashes, canonical run references, changed paths, exact diff,
risks, and validation plan. Each actionable canonical Proposal is admitted by
an immutable, project-owned receipt which binds the exact approved Spec,
Builder record hash, and Proposal hash. Workbench enumerates those admissions
instead of trusting project fields inside a shared runs directory, verifies the
admission before following evidence references, and therefore never opens
another project's malformed evidence while deriving the current Workbench.

## Visibility and sealed evidence

The canonical service checks the bounded EvalRun index and sealed corpus
hashes before opening member Runs. Sealed evidence cannot be selected, bundled,
diagnosed for authoring, or used to distinguish integrity failures. Builder Pi
sees only the bounded development projection and optional loopback Evidence
Explorer link.

## Deliberate next boundary

V1.5 makes “failure → proposal” exact and reviewable. It does not add semantic
clustering, hosted traces, production traffic Signals, autonomous Apply, or
autonomous promotion. The bounded exact-Git Target context and three-tool
authoring UX described as the next product slice are implemented in
[V1.6](V1_6_CONTEXT_AWARE_AUTHORING.md). Run comparison and systemic proposal
quality scoring remain later work.
