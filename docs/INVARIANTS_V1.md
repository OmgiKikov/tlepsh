# AHDE invariants — the exhaustive statement

These 44 invariants are the exhaustive statement behind the five guarantees
in the [README](../README.md). Nothing here is dropped when the product
surface changes; when a rule genuinely changes, its number keeps its place
and the text says what changed and why.

A note on the judge-written exam (invariants 5, 13 and 34): when the operator
has no data to hold out, the Target's *judge* model writes the sealed exam
from the approved Spec and a seeded, shape-only draw of published development
cases. The Builder never sees a case of it — it learns the count, the
generator's name and the prompt hash. A judge equal to the Target's own model
is refused for the same reason evaluator setup refuses it: a model that wrote
the exam must not be the model taking it. The draft mode writes to a private
file outside the repository for a human to read before `/holdout <path>`
seals it; the seal mode writes the corpus directly. Either way the exam stays
evaluator-only, and a judge-written exam is recorded as such on every verdict
it decides.

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
   five workshop tools exist only while a workshop session is active. The
   typed Tool Authoring operation accepts only logical credential slots; the
   host privately binds environment names, separately confirms declared
   network/filesystem/process capabilities, creates the complete package, and
   executes at least one happy-path and one error-handling contract fixture.
   A package with stale or failing fixture evidence cannot close. A clean
   shutdown suspends the exact worktree and host note for reattachment, while
   deleting runtime scratch and all live grants; explicit discard removes the
   worktree. Reattachment re-derives the exact Spec, basis, source, and snapshot
   before restoring authoring access.
   A capability exception is one-shot and host-owned, bound to the exact
   workshop snapshot, tool digest, phase, network mode, and env names; it is
   consumed before execution and is never restored after restart.
2. Evidence always points at immutable snapshots; renderers never reread the current checkout.
3. Candidate and baseline revisions differ, except in explicit A/A calibration mode.
4. Comparability excludes the changing Harness revision but includes every other effective execution and grading input.
5. The Target sees one holdout input at a time, never the holdout corpus,
   graders, expected answers, or future cases. This holds whatever backend runs
   it: an in-process Pi session receives the input as one user message, and a
   command Target receives it as one `user` line of the versioned protocol and
   nothing else — no case list, no grader, no reference answer, no world it was
   not given. What a Builder may rewrite about that Target is the surface the
   manifest declares in `harness.files`; absent, that is the Pi layout it has
   always been.
6. A Proposal cannot modify corpus or model configuration and cannot be applied
   without explicit human authority. An interactive apply means the human read
   THIS diff. Improve and proposal search instead authorize automated trials on
   throwaway branches and say explicitly that this is not individual diff
   review. Their receipts and Candidate origins record `via:
   "improvement-loop"` or `via: "proposal-search"`, so no reader can mistake
   them for reviewed applies. Improve lists changed paths in its cycle table;
   `/review` shows the exact diff, and review/ship bind that diff's artifact hash
   before recording release authority. Nothing touches the operator's branch or
   working tree before adoption.
   A Proposal may update only `AGENTS.md`,
   `skills/**`, `tools/**`, `bin/**`, `data/**`, and the manifest's declared
   resources. Only declared `data/` directories reach a Target workspace; they
   are bounded in total bytes and are shown to the Builder as shape, never
   content.
   An `execution.configure` intent may change the Target execution policy only
   in the same exact reviewed Proposal; omission preserves existing policy and
   container containment, while container replacement/removal is explicit.
   Every resulting tool must validate against that policy, and the Candidate
   must still pass matched development and sealed verification before
   promotion. Before the first eval, a construction Proposal may cite the exact
   approved Spec without inventing diagnosis evidence; every later improvement
   remains bound to conclusive development evidence.
7. The user's current checkout is never switched by an experiment.
8. Durable artifacts are schema-versioned, validated on read, and written
   atomically. Any transition spanning Git and artifact storage writes an exact
   immutable intent before the Git effect; restart either completes that same
   transition or fails closed, never infers a new decision from mutable state.
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
   and mode-aware, plus its declared lockfile bytes. A command Target's entry
   executable is Target identity on the same terms: `argv[0]` is resolved and
   hashed at spawn, not at resolution, and persisted as `agentEntryHash` on
   every Run and EvalRun. One eval run is one entry executable. The files the
   manifest declares in `harness.files` are Target identity on the same terms:
   they are part of the hashed model-visible workspace, so a rewritten prompt is
   a different Target and never a reusable baseline. A declared setup step runs
   once in a private per-tool staging home and scratch directory inside the
   same sandbox; it never receives write access to the shared final tool home.
   The staged directory is attested and atomically promoted into that home.
   The resulting tree is attested by canonical path, bytes, executable
   bits, and empty directories; symlinks and special files fail closed. That
   prepared-home hash is persisted in every member Run and EvalRun and must
   reproduce before cache reuse, baseline reuse, exact snapshot selection, or
   promotion. Setup failure or attestation drift is an infrastructure error.
   Missing confinement is recorded honestly and is never promotable.
   A declared `data/kb` turns on the host's in-process `kb_search`, whose only
   readable bytes are the run's own workspace copy of that directory. Its chunk
   index is setup-derived in exactly this sense — built once per runtime
   creation from the snapshot, by a versioned chunker whose geometry is part of
   the hash — so the index hash is folded into the same prepared-home identity.
   A Target with no knowledge base folds in nothing and its hash is unchanged.
18. Initial Target id/model configuration is a one-time host-confirmed bootstrap
    commit over an exact clean scaffold **or an exact clean adopted revision
    recorded in the receipt**. Builder receives only the credential
    variable name; the host injects the selected value into a memory-only Target
    credential store.
19. Every Run in one Eval Run is materialized from the same hash-checked source
    snapshot — including a command Target's child process, which is spawned
    with that snapshot copy as its working directory and never with the
    operator's checkout. Its exact workspace hash is persisted in the EvalRun and member
    Runs, participates in baseline reuse, and is mandatory promotion evidence.
    Changes to the live Target cannot be attributed only to an unchanged Git SHA.
20. Apply and Discard are durable, mutually exclusive terminal decisions for one
    exact Builder Proposal. One immutable decision claim serializes them before
    branch mutation or receipt publication; interrupted decisions appear as a
    recoverable pending state and only the exact claimed action may resume.
    Promote and Reject use the same rule for a reviewed Candidate. Promotion
    additionally binds an unsigned direct annotated tag, rejects symbolic refs,
    and keeps legacy promotion journals recoverable across upgrades.
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
24. A Target child process — interactive Pi, or a command Target — runs over a
    hash-checked workspace snapshot with frozen Harness resources and an
    in-memory session. The Node loader starts without inherited environment;
    credential, allowlisted runtime values, and fixed display/locale values
    arrive only over post-startup IPC. A command Target receives the same
    scrubbed environment a declared tool receives, plus its credential under
    the manifest's own `apiKeyEnv` name, the protocol version, and its case's
    world path; loader environment is refused by name. Shell escapes, undeclared
    tools, and ambient resume/import switching are denied.
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
29. Failure modes cluster by exact typed grader family — the check code and,
    where the check names one, its subject — never by the task-specific literal
    a case carries. A systemic failure mode requires that family to fail on at
    least two distinct tasks. Broad categories, names, free-form reasons, and
    semantic similarity are not sufficient evidence. What a mode states about
    itself is counted from the trace observations the diagnosis recorded, never
    inferred. Infrastructure makes a brief proposal-ineligible, and sealed
    evidence never enters a Builder-visible brief.
30. Harness authoring context is read only from the exact clean Git commit
   selected by the host. It enumerates no ambient files and exposes only
   the complete non-secret execution policy and canonical manifest-declared
   `AGENTS.md`, skill `SKILL.md`, and tool descriptor/executable resources —
   plus, when the manifest declares `harness.files`, exactly the files that
   surface names, bounded like a skill and counted one per file in the same
   closure rule. Host-owned configuration, the evaluation inputs, a declared
   `data/` tree and hidden files are never readable, whatever that surface
   globs over; a workshop over such a Target holds the declared surface and
   nothing else. Dirty or stale revisions, undeclared or
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
    a promotion on it is refused until the candidate is verified again. Early
    ship readiness host-verifies the actual private corpus bytes, mode, hash,
    parse, and task count; Builder receives only the coarse state `missing`,
    `underpowered`, `ready`, or `unavailable`.
35. Noise is measured, never assumed: an A/A calibration of the same Target
    revision is the receipt for run-to-run noise, informs the recommended
    number of repetitions, and is never promotion evidence.
36. A proposal search compares, it never decides. It applies each hypothesis
    on its own throwaway branch, screens it with the cheap check, and pays for
    a matched development verification only where the screen found something.
    It runs no sealed corpus, and its gate throws on every decision that
    creates release authority. Its screens are ordinary cheap-check screens
    and carry all four of that exclusion; its verification arms are ordinary
    development evidence whose candidate arm is never reused as a baseline.
    Which hypothesis wins is a human decision on the Pareto table, and that
    one candidate then meets the unchanged sealed gate and promotion.
37. The proposer reads what was already tried. Prior attempts are compiled
    from immutable candidate records — what changed, which failure modes it
    aimed at, what it scored, how it ended — bounded, newest first, with
    sealed evidence contributing a verdict and a design size and nothing else.
    That memory is never part of the authoring context hash or its claim, and
    the autoloop refuses to re-propose a change whose changed-path set and
    targeted failure mode match an attempt that already ended rejected or
    not `improved`.
38. Every evaluator model is a provenance axis, everywhere. The judge and the
    simulated user travel together on `provenanceAxes`, and every place that
    rebuilds a run's axes from a Target — the canonical `runSuite` index, the
    candidate experiment's reuse query, the snapshot verifier, and `regrade` —
    emits both by the same rule: a fingerprint when the suite configures one,
    an absent key (never `null`) when it does not, so provenance keys minted
    before either existed are byte-identical.
39. A human calibrating a judge grades the judge's own subject. One pure
    derivation, `judgeSubjectFor(run, grader)`, produces what a judge was shown
    and asked; the judge prompt builders and the labelling screen both consume
    it. A label records which subject it graded, and one written under an older
    screen is excluded from `requireCalibration` unless the Target declares
    `allowLegacyLabels: true`.
40. The evaluator models are configured through a host-confirmed reviewed
    commit, never by hand-editing YAML and never by a model. `configure-target`
    and `configure-evaluators` share one contract: a bounded selection resolved
    against the trusted host catalog, a credential variable NAME asked through
    the host UI and never a value, the exact non-secret `manifest.yaml` diff,
    one commit touching only `manifest.yaml`, and an immutable receipt. A judge
    equal to the Target's own model is refused.
41. A cheap-check screen's identity lives in its own EvalRun (`purpose:
    "screen"`), written atomically with the record. Baseline reuse, every
    non-exploratory comparison, promotion evidence, regression-case selection
    and the Workbench inventory refuse it by reading that field, so a process
    killed before the `runs/screens/` marker is written still leaves a run
    nothing admits. The marker remains as belt-and-braces and fails closed: an
    unreadable marker refuses everything it might name.
42. `ahde improve` binds a proposal to a cycle by SURFACE — dataset label and
    hash, suite hash, Target revision and approved Spec — plus the failure mode the proposal
    attests to, never by the id of an eval run the invocation itself just
    minted. A proposal prepared before the command therefore matches; one
    prepared after a stop still matches the next invocation while the surface
    holds; and one whose surface moved is refused with a typed reason naming
    what moved. Every invocation carries a loop id, its branches are
    `candidate/auto-<loopId>-<n>`, and a second `improve` over an unfinished
    loop reports it and refuses until `--resume` or `--abandon`. The ledger is
    checkpointed after every spend and created branch, and resumption also reads
    the Git refs so a crash cannot make a branch name reusable. The loop stops at
    the first verified candidate: compounding before a full-stack matched and
    sealed baseline exists would overstate what the evidence proved.
43. A command Target speaks exactly one versioned JSON-lines protocol. A
    protocol violation, an undeclared tool call or a non-zero exit is an
    infrastructure error, never a behavioural failure. Its transcript is written
    as canonical session JSONL and re-parsed by the canonical parser before the
    run may complete.

44. A case's world is part of the dataset's identity and lives outside the
    workspace snapshot; only sandboxed tools read and write it; an unreadable
    world is an infrastructure error, never a behavioural failure. The state a
    case declares is written once per Run under `runs/<id>/runtime/world/`,
    never into `workspace/`, so two cases that differ only in the world they
    happen in still materialize one hash-checked snapshot (invariant 19) and
    stay comparable. Its absolute path reaches every declared tool as
    `AHDE_WORLD`, host-owned exactly as `AHDE_TOOL_HOME` is: a declared
    environment allowlist can neither define it nor take it away, and the
    world's directory is a write root only for a tool whose descriptor already
    declares `workspace-write`. Neither the Builder nor the simulated user ever
    receives it — the Builder reads a bounded, redacted projection, and facts
    the person in the conversation genuinely knows belong in `goal` or
    `persona`. `world.expect` is sugar: every path that resolves a case's
    effective graders desugars each expectation into one `world_state` grader,
    so a world expectation is scored, explained and clustered as exactly one
    kind of check. A missing, oversized, malformed or symlinked world file
    makes the Run an error (invariant 9); a `world_state` check on a case that
    declares no world fails loudly rather than passing on nothing.
