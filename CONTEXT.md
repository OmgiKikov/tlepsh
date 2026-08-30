# AHDE Domain Context

AHDE is a local environment for designing, evaluating, and improving
project-specific Pi agent harnesses. It does not train models and it never lets
an evaluated agent promote its own changes. Bare `ahde` runs the Builder Pi;
the harness under development runs in a different Target Pi invocation.

## Domain language

- **Project** — the user-owned directory containing the agent specification and harness.
- **Spec** — the reviewed product contract for the agent: users, jobs, inputs, allowed actions, success criteria, and constraints.
- **Harness** — instructions, skills, and declared tools that shape the Target without changing its model weights.
- **Target** — a fresh Pi agent invocation being evaluated, or one disposable
  interactive Runtime Pi launched from the same resolved Harness. It receives
  only the capabilities declared by its Harness.
- **Builder** — a long-lived Pi agent that converses with the operator and invokes trusted, typed AHDE tools to design and improve a Harness. A Builder is never the Target it edits.
- **Workbench** — the deep host-owned orchestration module behind Builder Pi.
  Its `view`, `submit`, and `decide` operations derive the legal stage from
  validated immutable artifacts and receipts; mutable focus is selection only,
  never authority.
- **Corpus Draft** — private, immutable, agent-synthesized cases derived from one exact approved Spec. It is not runnable until a human explicitly publishes reviewed tasks.
- **Corpus Import Receipt** — immutable provenance binding one bounded,
  project-local JSONL source hash to the exact Spec-bound draft created from
  it. Input task ids are never trusted; AHDE derives new ids from the approved
  Spec and normalized task content.
- **Corpus** — versioned evaluation cases and graders. Development cases may be shown to the Builder; sealed holdout cases may not.
- **Harness Snapshot** — an immutable Git revision plus the exact Harness fingerprint used by a run.
- **Corpus Snapshot** — an immutable set of cases and grader configuration identified by content hash.
- **Experiment Design** — the comparison contract: corpus, task IDs, repetitions, execution fingerprint, judge fingerprint, and mode.
- **Run** — one Target execution for one case and repetition.
- **Eval Run** — a set of Runs evaluated under one Experiment Design.
- **Diagnosis** — structured failure families and evidence links derived from an Eval Run. Markdown and HTML are renderings, not the source of truth.
- **Improvement Brief** — a rebuildable, bounded projection that groups exact
  typed grader observations into systemic or task-local failure modes. Its
  explanations are hypotheses; the verified Eval Run and Diagnosis remain the
  evidence authority.
- **Workshop** — the Builder's bound writable surface: a detached worktree of
  one exact clean Target commit, scoped to `AGENTS.md`, `skills/**`,
  `tools/**`, `bin/**`, `data/**`, with read, write, an argv-only sandboxed
  shell, and `try_tool` over its own Harness copy. It changes nothing durable,
  writes no evidence, never touches the operator's checkout, and dies with the
  one proposal it compiles. Closing it derives the Proposal from `git diff`;
  the Harness Authoring Intents below remain the second path.
- **Harness Authoring Intent** — a semantic instruction/execution-policy/skill/tool change
  request. The host compiler, not Builder Pi, derives paths, modes, hashes,
  manifest declarations, and exact diffs from a clean Target snapshot. It is
  the fallback path for single-file edits and the only way to change the
  Target's execution policy; a workshop diff can change only resources.
- **Target Authoring Context** — a bounded safe projection of one exact clean
  Target commit: sanitized model/execution metadata plus only its
  manifest-declared instructions, skills, and tool descriptor/executable
  resources. Builder reads it through Workbench, never through ambient files.
- **Proposal** — the immutable exact Harness file replacement set compiled
  either from a closed Workshop's worktree diff or from Harness Authoring
  Intents, and tied to an approved Spec, baseline snapshot, and optional
  development Eval/Diagnosis evidence. Both paths produce the same artifact and
  pass the same scope assertion, admission receipt, and human apply gate.
- **Candidate** — a committed Harness Snapshot created from a human-applied Proposal and linked to the exact approved Spec used by its Builder.
- **Candidate Experiment** — the deep module that validates lineage and scope, evaluates exact baseline/candidate revisions, compares them, and records a human decision.
- **Promotion** — a human-approved immutable decision that tags the exact evaluated candidate revision. It is not autonomous deployment.
- **Adoption** — a separate human-confirmed fast-forward of the operator's
  current branch from the candidate baseline to the promoted revision, backed
  by an intent and a receipt. Only adoption changes the active Target.
- **Cycle continuation** — the human decision that closes a reviewed loop
  around one terminal (promoted-and-adopted or rejected) candidate and lets
  the Workbench derive the next stage from the active Target.
- **A/A calibration** — repeated evaluation of the same snapshot to measure
  run-to-run noise. The A/A Candidate record is the calibration receipt; it
  can never be promotion evidence.
- **Judge agreement** — how often a judge grader and a human reached the same
  verdict on the same answer, with Cohen's κ correcting for the agreement two
  indifferent raters would reach by chance. Humans supply the other side
  through `ahde label`, which shows the task and the answer, takes a blind
  pass/fail, and only then reveals the judge. Labels live under
  `<state-root>/projects/<id>/labels/<evalRunId>.jsonl`, are notes about an
  instrument rather than evidence about a Target — never a receipt, never a
  provenance axis, never collected from sealed evidence — and every judge
  screen reads `judge agreement 84% · κ 0.62 · n=50` or
  `judge not calibrated` from them. A Target may set
  `evalSuite.judge.requireCalibration` to refuse promoting evidence its judge
  has not earned.
- **Comparison Verdict** — the single typed outcome of comparing a baseline and
  a candidate Eval Run under one Gate Policy: paired per-task deltas of the
  mean grader score, a seeded bootstrap 95% interval, the design (tasks ×
  repetitions, excluded tasks), human flags, resource ratios, and one verdict.
  The only source of "passed".
- **Workbench gate policy** — how much of the operator's attention one decision
  is worth. Three consequential moments carry the whole cycle and each shows the
  exact subject before anything happens: `start-testing` (approve the Spec
  draft, publish the reviewed corpus draft, run), `apply-proposal` (the exact
  diff), and `ship` (review, promote, adopt, continue). The composites are
  orchestration, not new authority: they call the same application services in
  the same order, write the same receipts, pre-approve only the exact
  sub-subjects the operator already read, and stop at the first step that
  declines or fails. Terminal throw-aways — discard a proposal, reject a
  candidate, abandon an interrupted attempt — are one short question. Every
  other decision is routine: measurement (`run-current`, `run-eval`,
  `calibrate`, `verify-candidate`) executes without a dialog under a cost guard
  that asks once when history estimates more than `AHDE_ROUTINE_COST_USD`
  (default 2) or `AHDE_ROUTINE_MINUTES` (default 10), or when no comparable run
  has finished and the cost is unknown. Estimates are read from existing run
  artifacts and persist nothing. Consequential and one-question decisions still
  fail closed outside an interactive TUI; routine decisions may run headless.
- **Gate Policy** — the named rule a Comparison Verdict is decided under.
  `development-ci-v4`: improved iff the whole interval is above zero,
  regressed iff it is entirely below zero, otherwise inconclusive.
  `sealed-guardrail-v4`: underpowered below 15 tasks or 2 repetitions, fail
  iff the whole interval is below zero, otherwise pass. The paired quantity is
  the mean grader score per task, not the pass rate: a run scores the mean of
  its graders' scores in [0,1], a graderless run keeps the binary value, and
  with binary graders score and pass rate coincide. Pass rates stay computed
  and rendered next to the scores. Per-task drops, collapses, and the cost,
  latency and token ratios are flags for humans and never gate.

## Trust domains

AHDE deliberately uses Pi twice. These are different security principals, not
two modes of one session.

| Boundary | Builder Pi | Target Pi |
|---|---|---|
| Lifetime | Long-lived operator conversation | Fresh session per evaluated task or one disposable interactive child |
| System instructions | Packaged `builders/ahde/AGENTS.md` | Target-owned `AGENTS.md` |
| Skills | Packaged AHDE Builder skills only | Manifest-declared Target skills only |
| Tools | Trusted typed AHDE extension only | Policy-approved built-ins and declarative subprocess tools |
| Config/session root | User-level credentials and settings (`AHDE_HOME`, default `~/.ahde`); private per-project sessions | Private per-run state |
| Repository authority | No generic edit/write outside a bound workshop worktree (`AGENTS.md`, `skills/**`, `tools/**`, `bin/**`, `data/**`, never the operator's checkout); exact changes still pass a host TUI gate | Confined task workspace only |
| Private artifacts | Bounded views through AHDE core | No access |
| Sealed holdout | Never model-visible | One evaluator-supplied case at a time |
| Promotion authority | Host-owned explicit decision | None |

The web Evidence Explorer is outside both model trust domains. It is a
loopback-only, read-only projection of already-created canonical evidence. In
the long-lived Builder process it can additionally project bounded,
restart-ephemeral development RunEvents behind a random capability URL. That
live view is never evidence and cannot perform state transitions.

## Non-negotiable invariants

1. Builder and Target are different Pi invocations with different prompts,
   skills, tools, sessions, config roots, workspaces, and credentials.
   Builder Pi has no generic edit/write **outside a bound workshop worktree**:
   its only writable surface is one open Workshop over a detached copy of an
   exact clean Target commit, confined to `AGENTS.md`, `skills/**`, `tools/**`,
   `bin/**`, `data/**`. `manifest.yaml` is host-owned inside it (the host
   derives the declared skill/tool/data lists from the files that exist), and
   `evals/**`, `imports/**`, `runs/`, `.git`, `.env`, `.ahde`, traversal, and
   symlinks all fail closed on the resolved real path with the offending path
   named. The workshop's shell is argv-only inside the same OS sandbox a
   declared Target tool runs in, with bounded output and a bounded timeout. The
   four workshop tools exist only while a workshop is open; the workshop is
   bound to one proposal attempt and dies with it, leaving no worktree behind.
2. Evidence always points at immutable snapshots; renderers never reread the current checkout.
3. Candidate and baseline revisions differ, except in explicit A/A calibration mode.
4. Comparability excludes the changing Harness revision but includes every other effective execution and grading input.
5. The Target sees one holdout input at a time, never the holdout corpus, graders, expected answers, or future cases.
6. A Proposal cannot modify corpus or model configuration and cannot be applied
   without an explicit human command. It may update only `AGENTS.md`,
   `skills/**`, `tools/**`, `bin/**`, `data/**`, and the manifest's declared
   resources. Only declared `data/` directories reach a Target workspace; they
   are bounded in total bytes and are shown to the Builder as shape, never
   content.
   A complete `execution.configure` intent may change the Target execution
   policy only in the same exact reviewed Proposal; every resulting tool must
   validate against that policy, and the Candidate must still pass matched
   development and sealed verification before promotion.
7. The user's current checkout is never switched by an experiment.
8. Durable artifacts are schema-versioned, validated on read, and written atomically.
9. Infrastructure failures are inconclusive evidence, not behavioral failures.
10. Raw traces are protected evidence and are rejected before read/parse when
    their canonical byte or record bound is exceeded; reports use bounded,
    redacted normalized views.
11. Live RunEvents are provisional, in-process observations. TUI and web are
    bounded host-only projections of the same redacted event seam; no second
    journal or mutable trace reader exists. Listener, HTTP, SSE, UI, and viewer
    failure cannot change execution, grading, durable evidence, or Workbench
    state; sealed holdout runs never attach a Builder-visible listener.
12. A canonical Builder-seeded Candidate must link the immutable typed Builder input, run, proposal, human apply receipt, and approved Spec; source Eval/Diagnosis is linked exactly when supplied.
13. A Builder never sees sealed corpus content, and a Corpus Draft never becomes development or sealed evidence without an explicit human publication action.
14. Promotion re-reads and hashes the complete durable chain; a manual-origin Candidate is experimental evidence only and cannot be promoted.
15. A Builder-seeded Candidate re-tests the exact development surface that produced its source Eval: dataset label, dataset hash, and suite hash must match. Published development corpus identity/hash is persisted in Candidate evidence and re-verified at promotion; sealed content is never exposed by that provenance.
16. Consequential Builder tools never accept model-supplied authority. The host
    confirms an exact immutable subject in TUI mode, revalidates it, and records
    a one-operation receipt; non-interactive calls fail closed.
17. Declarative Target tool descriptors and executable bytes are part of Target
    identity: for a multi-file tool that is every file in its directory, sorted
    and mode-aware, plus its declared lockfile bytes. A declared setup step runs
    once per prepared tool home, inside the same sandbox, writing only that
    home; its output is derived state that no provenance hash sees, and its
    failure is an infrastructure error. Missing confinement is recorded honestly
    and is never promotable.
18. Initial Target id/model configuration is a one-time host-confirmed bootstrap
    commit over an exact clean scaffold. Builder receives only the credential
    variable name; the host injects the selected value into a memory-only Target
    credential store.
19. Every Run in one Eval Run is materialized from the same hash-checked source
    snapshot. Its exact workspace hash is persisted in the EvalRun and member
    Runs, participates in baseline reuse, and is mandatory promotion evidence.
    Changes to the live Target cannot be attributed only to an unchanged Git SHA.
20. Apply and Discard are durable, mutually exclusive terminal decisions for one
    exact Builder Proposal.
21. Workbench may advance only from receipt-backed, revalidated artifacts in
    the exact selected lineage. A Spec approval cannot authorize another Spec's
    corpus, and a development corpus cannot be reused across Spec or Target
    identities merely because mutable focus points at it.
22. Corpus publication records an immutable Workbench lineage binding the exact
    approved Spec, reviewed corpus draft, canonical publication receipt,
    and development dataset hash. Publication is restart-safe across a crash
    between the canonical receipt and lineage record. Eval compatibility then
    additionally requires the current Target revision and suite hash, so the
    same reviewed corpus can measure a later exact Target without re-publication.
23. Every consequential Workbench decision is legal only in its derived stage.
    `/run` cannot skip Spec or corpus review, and inconclusive execution cannot
    advance the workflow.
24. Interactive Target Pi runs in a dedicated child over a hash-checked
    workspace snapshot with frozen Harness resources and an in-memory session.
    The Node loader starts without inherited environment; credential,
    allowlisted runtime values, and fixed display/locale values arrive only over
    post-startup IPC. Shell escapes, undeclared tools, and ambient resume/import
    switching are denied.
25. An interrupted candidate is neither failed nor retryable by omission. A
    human must write an exact immutable abandonment receipt before Workbench
    may start a replacement verification attempt.
26. Candidate authority is transitive and exact. An applied candidate is usable
    only while its Builder run, Builder input, Proposal, Apply receipt, approved
    Spec, and optional Eval/diagnosis source artifacts rehash to the admitted
    receipt-backed lineage. Candidate records from another project are not part
    of the current Workbench inventory.
27. Builder corpus imports are confined to regular, non-symlink JSONL files in
    the project-local `imports/` inbox, which is excluded from Git and every
    Target/evaluation workspace snapshot. They are
    size/count bounded, read from one stable inode, normalized into newly
    derived Spec-bound task ids, and linked to an immutable source-hash receipt
    that is authority-checked across the entire imported draft lineage.
28. A trace-derived regression case may cite only a hash-indexed, completed
    behavioral failure from the currently compatible development
    Target/corpus/EvalRun surface. AHDE verifies the source trace input against
    the canonical case, persists bounded hashes and ids rather than trace
    output, and rejects duplicates, infrastructure failures, passing runs,
    foreign evidence, candidate evidence, and all sealed evidence.
29. A systemic failure mode requires the same exact typed grader signature on
    at least two distinct tasks. Broad categories, names, free-form reasons,
    and semantic similarity are not sufficient evidence. Infrastructure makes
    a brief proposal-ineligible, and sealed evidence never enters a
    Builder-visible brief.
30. Harness authoring context is read only from the exact clean Git commit
    selected by the host. It enumerates no ambient files and exposes only
    canonical manifest-declared `AGENTS.md`, skill `SKILL.md`, and tool
    descriptor/executable resources. Dirty or stale revisions, undeclared or
    private paths, traversal, symlinks, unsafe modes, malformed UTF-8, and
    oversized context fail closed before Proposal compilation. Git replacement
    refs are ignored. Structured authoring must echo the host-minted context
    claim; AHDE re-derives and persists it, pins compilation to its revision,
    and applies the same inspectability limits to the proposed resulting
    Harness so Builder cannot author itself out of context. A Workshop holds
    that claim host-side rather than asking for it back: it is minted when the
    workshop opens, re-derived and required to be identical when it closes, the
    diff is refused if the checkout moved or is dirty, and the same
    inspectability limits are applied to the Harness the diff would create.
31. Promotion never moves the active Target. Adoption is a separate
    human-confirmed fast-forward of a clean worktree from the exact candidate
    baseline to the exact promoted revision; its intent and receipt bind the
    candidate record hash and are re-verified by inventory.
32. A terminal candidate leaves Workbench focus only through an explicit
    continuation receipt, and a promoted candidate requires its adoption
    receipt first. The next stage is derived from artifacts, never from the
    closed candidate.
33. Human-facing rendering is downstream of every decision. Transcript
    blocks are persisted host UI that the model never receives; a renderer
    fault degrades to the Workbench message and can never change durable
    state or skip a confirmation.


34. Promotion is decided by the Comparison Verdict, not by per-task flips: it
    requires `exact-comparison-gate-v4` evidence on both surfaces, a sealed
    guardrail `pass` (≥15 tasks × ≥2 repetitions, 95% paired bootstrap interval
    over per-task mean grader scores not entirely below zero) and a development
    verdict other than `regressed`. A failed or underpowered sealed gate is
    recorded as evaluated evidence and refused at promotion; it is never thrown
    away. A verification never starts on a holdout smaller than the policy
    minimum. Older evidence (v1–v3) stays readable and renders its verdict, but
    a promotion on it is refused until the candidate is verified again.
35. Noise is measured, never assumed: an A/A calibration of the same Target
    revision is the receipt for run-to-run noise, informs the recommended
    number of repetitions, and is never promotion evidence.