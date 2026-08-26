# AHDE Domain Context

AHDE is a local environment for designing, evaluating, and improving
project-specific Pi agent harnesses. It does not train models and it never lets
an evaluated agent promote its own changes. Bare `ahde` runs the Builder Pi;
the harness under development runs in a different Target Pi invocation.

## Domain language

- **Project** — the user-owned directory containing the agent specification and harness.
- **Spec** — the reviewed product contract for the agent: users, jobs, inputs, allowed actions, success criteria, and constraints.
- **Harness** — instructions, skills, and declared tools that shape the Target without changing its model weights.
- **Target** — a fresh Pi agent invocation being evaluated. It receives one task input and only the capabilities declared by its Harness.
- **Builder** — a long-lived Pi agent that converses with the operator and invokes trusted, typed AHDE tools to design and improve a Harness. A Builder is never the Target it edits.
- **Corpus Draft** — private, immutable, agent-synthesized cases derived from one exact approved Spec. It is not runnable until a human explicitly publishes reviewed tasks.
- **Corpus** — versioned evaluation cases and graders. Development cases may be shown to the Builder; sealed holdout cases may not.
- **Harness Snapshot** — an immutable Git revision plus the exact Harness fingerprint used by a run.
- **Corpus Snapshot** — an immutable set of cases and grader configuration identified by content hash.
- **Experiment Design** — the comparison contract: corpus, task IDs, repetitions, execution fingerprint, judge fingerprint, and mode.
- **Run** — one Target execution for one case and repetition.
- **Eval Run** — a set of Runs evaluated under one Experiment Design.
- **Diagnosis** — structured failure families and evidence links derived from an Eval Run. Markdown and HTML are renderings, not the source of truth.
- **Proposal** — a Builder-authored, typed set of Harness file replacements tied to an exact approved Spec, baseline snapshot, and optional development Eval/Diagnosis evidence.
- **Candidate** — a committed Harness Snapshot created from a human-applied Proposal and linked to the exact approved Spec used by its Builder.
- **Candidate Experiment** — the deep module that validates lineage and scope, evaluates exact baseline/candidate revisions, compares them, and records a human decision.
- **Promotion** — a human-approved immutable decision that tags the exact evaluated candidate revision. It is not autonomous deployment.
- **A/A calibration** — repeated evaluation of the same snapshot to measure noise. It can never be promotion evidence.

## Trust domains

AHDE deliberately uses Pi twice. These are different security principals, not
two modes of one session.

| Boundary | Builder Pi | Target Pi |
|---|---|---|
| Lifetime | Long-lived operator conversation | Fresh session per evaluated task |
| System instructions | Packaged `builders/ahde/AGENTS.md` | Target-owned `AGENTS.md` |
| Skills | Packaged AHDE Builder skills only | Manifest-declared Target skills only |
| Tools | Trusted typed AHDE extension only | Policy-approved built-ins and declarative subprocess tools |
| Config/session root | Private Builder state | Private per-run state |
| Repository authority | No generic edit/write; exact changes pass a host TUI gate | Confined task workspace only |
| Private artifacts | Bounded views through AHDE core | No access |
| Sealed holdout | Never model-visible | One evaluator-supplied case at a time |
| Promotion authority | Host-owned explicit decision | None |

The web Evidence Explorer is outside both model trust domains. It is a
loopback-only, read-only projection of already-created canonical evidence and
cannot perform state transitions.

## Non-negotiable invariants

1. Builder and Target are different Pi invocations with different prompts,
   skills, tools, sessions, config roots, workspaces, and credentials.
2. Evidence always points at immutable snapshots; renderers never reread the current checkout.
3. Candidate and baseline revisions differ, except in explicit A/A calibration mode.
4. Comparability excludes the changing Harness revision but includes every other effective execution and grading input.
5. The Target sees one holdout input at a time, never the holdout corpus, graders, expected answers, or future cases.
6. A Proposal cannot modify corpus/model/execution configuration and cannot be
   applied without an explicit human command. It may update only `AGENTS.md`,
   `skills/**`, `tools/**`, `bin/**`, and the manifest's `skills`/`tools`
   declaration lists.
7. The user's current checkout is never switched by an experiment.
8. Durable artifacts are schema-versioned, validated on read, and written atomically.
9. Infrastructure failures are inconclusive evidence, not behavioral failures.
10. Raw traces are protected evidence; reports use bounded, redacted normalized views.
11. A canonical Builder-seeded Candidate must link the immutable typed Builder input, run, proposal, human apply receipt, and approved Spec; source Eval/Diagnosis is linked exactly when supplied.
12. A Builder never sees sealed corpus content, and a Corpus Draft never becomes development or sealed evidence without an explicit human publication action.
13. Promotion re-reads and hashes the complete durable chain; a manual-origin Candidate is experimental evidence only and cannot be promoted.
14. A Builder-seeded Candidate re-tests the exact development surface that produced its source Eval: dataset label, dataset hash, and suite hash must match. Published development corpus identity/hash is persisted in Candidate evidence and re-verified at promotion; sealed content is never exposed by that provenance.
15. Consequential Builder tools never accept model-supplied authority. The host
    confirms an exact immutable subject in TUI mode, revalidates it, and records
    a one-operation receipt; non-interactive calls fail closed.
16. Declarative Target tool descriptors and executable bytes are part of Target
    identity. Missing confinement is recorded honestly and is never promotable.
17. Initial Target id/model configuration is a one-time host-confirmed bootstrap
    commit over an exact clean scaffold. Builder receives only the credential
    variable name; the host injects the selected value into a memory-only Target
    credential store.
18. Every Run in one Eval Run is materialized from the same hash-checked source
    snapshot. Its exact workspace hash is persisted in the EvalRun and member
    Runs, participates in baseline reuse, and is mandatory promotion evidence.
    Changes to the live Target cannot be attributed only to an unchanged Git SHA.
19. Apply and Discard are durable, mutually exclusive terminal decisions for one
    exact Builder Proposal.
