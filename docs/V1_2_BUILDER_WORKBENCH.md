# AHDE V1.2 — Builder Workbench

V1.2 implements the product loop as two Pi runtimes separated by a deterministic
host-owned Workbench:

```text
operator <-> Builder Pi <-> Workbench <-> immutable AHDE core
                                      |
                                      +-> evaluation Target Pi
                                      +-> disposable interactive Target Pi
```

Builder Pi is the long-lived agent builder. Runtime Pi is the agent being built.
They never share instructions, skills, tools, config/session roots, credentials,
or workspaces.

## Product surface

Bare `ahde` opens Builder Pi. The operator can use free text and seven shortcuts:

```text
/status  /run  /traces  /review  /apply  /discard  /target
```

`ahde target` opens the Target Harness in the current directory in a separate,
disposable Pi process; `--target <dir>` selects another Target explicitly. It is
useful for trying the agent by hand, but its session is not evaluation or
promotion evidence.

The trusted Builder extension exposes three primary model-facing operations:

| Operation | Authority |
|---|---|
| `ahde_workbench_view` | Read stage, legal actions, selections, exact review, traces, or Target detail |
| `ahde_workbench_submit` | Save immutable drafts/revisions, semantic Harness intents, or explicit selections |
| `ahde_workbench_decide` | Request exactly one stage-legal transition through a host-owned human gate |

The older narrow `ahde_*` tools remain for initial Target bootstrap and
script/adapter compatibility. Valid legacy development corpora without a V1.2
Spec-bound lineage remain readable core evidence but are explicitly ignored as
Workbench authority; new loops should use the three primary operations.

## Derived state machine

```text
target-setup
  -> spec-design -> spec-review -> corpus-design -> corpus-review
  -> ready-to-evaluate -> improvement-authoring -> proposal-review
  -> candidate-verification -> candidate-review -> release-decision
  -> complete
```

Ambiguous artifacts produce `selection-required`; they never silently pick the
newest record. The Workbench re-derives this state from validated canonical
artifacts on every call. `workbench/focus.json` is an atomic, hash-checked
selection hint only. Deleting or corrupting it cannot create authority.

Every consequential transition reloads the exact subject, renders a bounded
confirmation including its content/hash, asks through the trusted local TUI,
re-derives the stage and authority inventory, revalidates the subject, and then
calls the existing deterministic application service. The exhaustive
decision-to-stage policy lives at one typed boundary. Headless calls fail
closed.

## Authoring without raw repository authority

Builder Pi can create immutable Spec drafts and Spec-bound corpus drafts. It can
also import a bounded JSONL file from the private project-local `imports/` inbox
as a new editable draft. That inbox is git-ignored and excluded from all Target
Pi and evaluation workspace snapshots. Import rejects every other path,
traversal, symlinks, private AHDE/run roots, unstable reads, and
malformed or oversized content; source task ids are discarded and an immutable
relative-path/hash receipt binds the exact imported bytes to the resulting draft
and is revalidated after restart. Corpus revisions are semantic operations
(`add`, `replace`, `remove`, `set-graders`, `grader.add`, `grader.update`,
`grader.remove`, `rename`, and `set-notes`) and keep an immutable parent lineage.
Human publication creates the canonical development Corpus plus a Workbench
lineage record binding:

- exact approved Spec and approval receipt;
- exact reviewed corpus draft;
- canonical publication receipt;
- canonical development dataset hash.

The corpus remains reusable across Target revisions. Advancement to proposal
authoring additionally requires a conclusive EvalRun whose Target revision,
dataset hash, and suite hash match the currently selected Target + corpus.

Harness improvement uses semantic intents:

- replace `AGENTS.md` instructions;
- upsert or remove one named skill;
- upsert or remove one named declarative tool.

The compiler owns paths, file modes, hashes, manifest declarations, descriptor
validation, and unified diffs. It requires the exact clean baseline and emits an
ordinary immutable `CandidateProposal`; the existing apply/candidate/promotion
core therefore remains the sole mutation and release authority.

## Evaluation, tracing, and recovery

`/run` means the one legal measurement for the current stage: development eval
before a proposal, exact candidate verification after Apply. A failed
infrastructure run is inconclusive and does not advance state. Candidate
verification chooses sealed evidence only in the host UI; Builder Pi receives
neither its identifier nor its contents.

`/traces` returns bounded diagnosis plus a loopback Evidence Explorer link.
The web surface is GET/HEAD-only and cannot create runs, proposals, or decisions.

`add-case-from-run` turns one exact failed development Run into provenance for
a new Builder-authored neighboring regression case. The host reloads the
hash-indexed EvalRun and Run, verifies current Spec/Target/corpus compatibility,
requires a completed behavioral failure, rehashes the trace, and checks its
first user input against the canonical source task. The new draft stores only
bounded corpus/eval/run/trace/task ids and hashes. Exact duplicates, passing or
infrastructure runs, foreign/candidate evidence, trace tampering, and all sealed
evidence are rejected.

Publication and candidate recovery are explicit:

- if a process dies after canonical corpus publication but before Workbench
  lineage publication, repeating the exact decision repairs the missing lineage
  idempotently;
- if candidate verification is interrupted after its record appears, the human
  must review and write an immutable abandonment receipt before retrying.

Apply and Discard remain mutually exclusive terminal proposal outcomes.
An applied candidate is admitted only when its Builder run, input, proposal,
apply receipt, approved Spec, and optional Eval/diagnosis source artifacts all
rehash to the exact admitted chain. Foreign-project candidates are never
projected into the current Workbench.

## Interactive Runtime Pi boundary

Production interactive Target launch uses a dedicated child process because Pi
necessarily owns process-level TTY, cwd, and environment state. The child gets:

- a hash-checked isolated Target snapshot;
- frozen copies of Target instructions and skills;
- only manifest-declared tools and execution policy;
- the selected model credential, allowlisted runtime environment, and a fixed
  display/locale allowlist delivered over IPC only after Node loader startup;
- private temp roots and an in-memory session;
- guards against shell escape, undeclared tools, resume/import switching, and
  thinking-level drift from the manifest.

This surface cannot modify the Builder, canonical source checkout, corpus,
evidence, or promotion state.

## Canonical storage added in V1.2

```text
<state-root>/projects/<project-id>/
  builder-corpus-drafts/<draft-id>.json
  builder-corpus-imports/<import-id>.json
  workbench/focus.json
  workbench/corpus-publications/<corpus-id>.json
  workbench/candidate-abandonments/<candidate-id>.json
```

All authoritative records are strict, schema-validated, bounded, atomically
written, and revalidated on read. Only `focus.json` is mutable; it carries no
decision authority.

## Acceptance bar

The release gate covers the full Spec-to-Corpus-to-Eval-to-Proposal-to-Candidate
lineage, restart recovery, stale decisions, ambiguous selection, sealed-count
redaction, focus tamper, structured authoring, JSONL import provenance,
first-class grader edits, failed-trace regression derivation, Builder commands,
interactive Target isolation, package contents, the production-shaped demo,
and the full test/typecheck suite.
