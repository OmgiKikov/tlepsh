# AHDE V1 — Local Agent Workbench (superseded)

> **Superseded:** this document records the earlier mutable Studio and
> one-shot-adapter design. It is not the current product contract. See
> [V1.1 — Two-Pi Builder Architecture](V1_1_WORKBENCH_PLAN.md): bare `ahde`
> launches Builder Pi, the harness runs as a separate Target Pi, and the web
> surface is a read-only Evidence Explorer. Any Studio/companion claims below
> are historical.

## Outcome

A user can start with a rough idea, refine it with an interactive Studio into a reviewed Spec, build a Harness and evaluation Corpus, run a Target, inspect failures and traces, ask a selectable Builder to propose a change, approve that proposal, evaluate an exact Candidate against an exact baseline, and promote or reject it with an auditable record.

V1 is local-first, macOS/Linux, single-user, and has no RL or weight training.

## User flow

```text
rough idea
   │
   ▼
Studio workshop ──► approved Spec snapshot ──human review──► Harness + private Corpus draft
                                                                  │
                                                   human publish──► development Corpus
                                                      │
                                                      ▼
                                             immutable baseline snapshot
                                                      │
                                                      ▼
                                              Target runs + protected traces
                                                      │
                                                      ▼
                                  Diagnosis JSON ──► browser report
                                                      │
                                                      ▼
                             Builder proposal ──human apply──► Candidate commit
                                                                  │
                                                                  ▼
                              exact baseline/candidate experiment + uncertainty
                                                                  │
                                              human promote or reject decision
```

## Product interfaces

### Studio

- Free-form rough input, tool-free agent-assisted structuring, editable fields, and explicit Spec/Corpus checkpoints.
- Writes explicit artifacts rather than relying on chat memory.
- Shows the next safe action, exact evidence identity, and backend capability status.
- Proposal application, Corpus publication, review, promotion, and rejection always require explicit human actions in Studio or CLI.

### Builder adapters

All adapters implement `approved Spec + optional development evidence in → proposal out`. The reference adapter is embedded tool-free Pi. Process adapters can invoke Codex or Claude Code, but only their normalized proposal is trusted. Adapter capabilities are reported explicitly; internal trace parity is not assumed. Sealed evidence is rejected at the boundary.

### Candidate Experiments

```text
evaluate(baseRef, candidateRef, design, policy)
  ├─ resolve immutable SHAs and ancestry
  ├─ reject scope violations before model calls
  ├─ create detached worktrees
  ├─ run matched baseline/candidate design
  ├─ validate evidence fingerprints
  ├─ compute paired task delta + uncertainty
  └─ persist immutable CandidateRecord
```

### Browser report

A self-contained local report presents project status, task aggregates, regressions, failure families, grader evidence, tool calls, latency/tokens/cost, and bounded normalized traces. It is read-only; raw protected artifacts remain on disk.

## Artifact lifecycle

```text
Builder:    proposed ──human apply──► candidate commit + immutable receipt
Candidate:  proposed ──built──► validated ──evaluated ──reviewed ──┬──► promoted
                                             └──► rejected

Experiment run: queued ─► running ─┬─► completed
                                   ├─► inconclusive
                                   └─► cancelled
```

Invalid transitions fail before side effects. Candidate decisions are terminal. A/A records are permanently ineligible for promotion.

## Evidence protocol

- Unit of inference is the task; repetitions measure within-task stochasticity.
- Baseline and candidate use identical task IDs and repetition counts.
- Reports show paired task-level delta and a deterministic 95% bootstrap confidence interval.
- A/A calibration measures observed noise; `30 cases` is a bootstrap default, not a guarantee.
- Development drives diagnosis and proposals. Sealed holdout is run only on a frozen candidate for the final gate.
- Promotion policy: distinct related SHAs, no infrastructure errors, comparable development evidence, no per-task or aggregate sealed regression, sealed-holdout evidence, and an explicit human promote review. A/A evidence is never promotable.

## Storage

Files are canonical in V1; there is no database.

```text
<project>/
  manifest.yaml
  AGENTS.md
  skills/
  tools/
  evals/development.jsonl

<runs-root>/
  <run-id>/{run.json,session.jsonl,judge/**}
  <eval-run-id>/{eval_run.json,diagnosis.json,report.html}
  builders/<builder-run-id>/{builder_input.txt,builder_run.json,events.jsonl,proposal.json,apply_receipt.json}
  candidates/<candidate-id>/candidate.json

<state-root>/projects/<project-id>/
  specs/spec-<hash>.json
  corpus-drafts/corpus-draft-<hash>.json
  corpora/corpus-<hash>/
```

Every JSON artifact has a schema version and a bounded read. Writes are atomic; immutable evidence uses exclusive publication. Eval indexes hash every final Run record. HTML reports are rebuildable projections.

## Milestones

1. **Evidence core** — strict codecs, atomic storage, complete comparability fingerprint, strict trace integrity, clean package/install.
2. **Candidate Experiment** — exact refs, detached worktrees, executable scope policy, A/A mode, typed lifecycle, atomic decisions.
3. **Capability isolation** — no implicit resources, declared Target tools, scrubbed environment, sealed holdout outside Builder-visible roots.
4. **Studio and proposals** — Spec/Corpus workflow, embedded Pi proposal adapter, generic process adapter, explicit apply.
5. **Diagnosis and report** — structured failure families and read-only local HTML trace/comparison viewer.
6. **Release gate** — clean-clone CI, mocked end-to-end workflow, package smoke test, real pilot checklist.

## Acceptance matrix

| Capability | Automated evidence |
|---|---|
| Clean installation | fresh-clone `npm ci`, build, tests, package import/bin smoke |
| Exact comparison | tests for same SHA, unrelated SHA, dirty repo, changed checkout, repetition/task/fingerprint mismatch |
| Safe proposal | exact Spec/input provenance, path traversal, symlink ancestor, disallowed file, stale baseline, malformed output, and explicit-approval tests |
| Recoverable artifacts | corrupt JSON, interrupted atomic write, stale worktree, cancelled experiment tests |
| Sealed holdout | Builder-visible filesystem test proves corpus/graders are absent; CLI/Studio steering rejects sealed eval evidence |
| Adapter contract | identical proposal conformance suite for embedded and process adapters |
| Human decision | promotion cannot occur from A/A, regression, wrong SHA, or without explicit command/reason |
| Inspectable evidence | report snapshot test plus browser smoke test over an end-to-end mocked experiment |

## NOT in scope

- RL, fine-tuning, or model-weight updates.
- Cloud control plane, multi-user auth, billing, or hosted trace storage.
- Autonomous proposal application, promotion, merge, or deployment.
- A full frontend framework; V1 uses a self-contained read-only local report.
- Uniform internal traces for Codex/Claude/Pi. Only the proposal adapter contract is normalized.
- Windows guarantees, OTLP export, distributed execution, or Kubernetes.
- A multi-package monorepo or Pi source fork until a concrete engine limitation requires one.
