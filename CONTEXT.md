# AHDE domain context

AHDE measures agent harnesses. It does not train models, and it never lets an
evaluated agent promote its own changes. Five guarantees carry the trust model;
[docs/INVARIANTS_V1.md](docs/INVARIANTS_V1.md) is the exhaustive 42-invariant
statement they summarize, kept unchanged.

## The five guarantees

**1. The sealed exam is never readable by any model.** A sealed Corpus is
reserved at ingest before anyone inspects the data; no model-visible
projection, brief, diagnosis, report or event stream carries sealed content,
and a sealed run attaches no model-visible listener — the engine emits its
counts, its design size and its verdict, nothing else.

**2. Nothing ships without evidence and a human.** Promotion requires
`exact-comparison-gate-v4` evidence on both surfaces: a development verdict
other than `regressed`, a sealed guardrail `pass` at ≥15 tasks × ≥2
repetitions, an applied Proposal with its receipt, and an explicit human
decision. A failed or underpowered sealed gate is recorded and refused at
promotion, never discarded. Consequential decisions fail closed outside an
interactive TUI; the `ahde serve` API is a transport for the same gate, where a
decision blocks on a confirmation bound to the exact host-minted subject hash.
Money is authorized once per cycle: the apply question prices the verification
that follows it and records that authorization on the receipt, so the check runs
without a second money question while it stays within 1.5× the approved amount,
and a candidate applied outside that dialog authorizes nothing.

**3. Every number traces to an immutable run artifact.** Evidence points at
hash-pinned Harness and Corpus snapshots; renderers never reread the checkout.
Durable artifacts are schema-versioned, validated on read and written
atomically, and a transition spanning Git and artifact storage writes its intent
before the Git effect, so a restart completes it or fails closed. Promotion
rehashes the whole chain. Infrastructure failures are inconclusive, never
behavioral results.

**4. The built agent runs only declared tools, in a sandbox, with declared
permissions.** A Target sees only manifest-declared instructions, skills, tools
and data, in a fresh session over a hash-checked workspace snapshot. Tool
descriptors and executable bytes — every file of a multi-file tool, mode-aware,
plus its lockfile — are Target identity and must reproduce before cache reuse,
baseline reuse or promotion. Attestation drift is an infrastructure error, and
missing confinement is recorded honestly and is never promotable.

**5. The builder edits only a branch; main moves only by promotion and
adoption.** A Proposal may replace `AGENTS.md`, the manifest's declared
resources, `skills/**`, `tools/**`, `bin/**` and `data/**` — anything outside
that scope is refused by name. Candidates are committed on `candidate/<id>` from
a private worktree, so no experiment switches the operator's checkout. Promotion
tags the evaluated revision without moving the active Target; only a separate
human-confirmed Adoption fast-forwards it.

## Glossary

- **Target** — the agent under development: a directory with `spec.md`,
  `manifest.yaml`, `AGENTS.md`, skills, tools, evals. At evaluation time, also
  the fresh Pi invocation that runs one case.
- **Harness** — the instructions, skills and declared tools shaping the Target
  without touching its weights. What AHDE improves.
- **Spec** — the reviewed contract: purpose, users, jobs, inputs, allowed
  actions, success criteria, constraints. `ahde spec approve` makes it typed and
  binding; criteria map 1:1 onto graders.
- **Corpus** — versioned cases plus graders, identified by content hash.
  **Development** cases may be shown to the builder; **sealed** may not.
- **Run** — one Target execution of one case, one repetition.
- **Eval Run** — Runs under one Experiment Design: corpus, task ids,
  repetitions, execution and judge fingerprints, mode.
- **Diagnosis** — failure modes derived from an Eval Run. A *systemic* mode
  needs one exact typed grader signature on two distinct tasks; explanations are
  hypotheses, the Eval Run stays the evidence.
- **Proposal** — the immutable exact file-replacement set compiled from a branch
  diff, bound to an approved Spec, a baseline snapshot and its development
  evidence. Compiling one applies nothing.
- **Candidate** — a committed Harness snapshot from a human-applied Proposal,
  linked to the exact Spec, builder run, proposal and receipt.
- **Promotion** — the human decision tagging the evaluated candidate revision.
  Not deployment, never autonomous.
- **Adoption** — the human-confirmed fast-forward of the operator's branch onto
  the promoted revision. Only adoption moves the active Target.
- **A/A calibration** — repeated evaluation of the *same* revision to measure
  run-to-run noise. Never promotion evidence; a delta inside the band is noise.
- **Screen** — the cheap check: previously failing cases, once, candidate arm
  only. Its Eval Run carries `purpose: "screen"` and is refused as evidence.
- **Judge subject** — what one judge grader was given: the request (or goal and
  transcript), the answer, the rubric or assertions, the reference answer when
  used. `judgeSubjectFor` feeds the judge prompt and `ahde label` alike.
- **Judge agreement** — how often judge and human reached the same verdict on
  that subject, Cohen's κ correcting for chance: `judge agreement 84% · κ 0.62 ·
  n=50`, or `judge not calibrated`. Labels grade the instrument, not the Target.
- **Comparison verdict** — comparing a baseline and a candidate Eval Run: paired
  per-task deltas of the mean grader score, a seeded bootstrap 95% interval, one
  verdict. The only source of "passed"; ratios and flips are flags, never gates.
- **`development-ci-v4`** — improved iff the interval is wholly above zero,
  regressed iff wholly below, else inconclusive.
- **`sealed-guardrail-v4`** — underpowered below 15 tasks or 2 repetitions,
  fail iff the interval is wholly below zero, else pass.
