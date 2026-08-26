# AHDE V1.1 — Two-Pi Builder Architecture

This plan synthesizes the independent `plan-eng-review`,
`improve-codebase-architecture`, and
`thermo-nuclear-code-quality-review` passes.

## Product outcome

`ahde` opens a real, long-lived Pi session that acts as the AHDE Builder. The
operator can describe an agent in ordinary language; Builder Pi turns that
conversation into an approved Spec, a maintainable development corpus, Target
harness resources, evaluation runs, diagnoses, and reviewed improvement
proposals.

The agent being built is a different Pi runtime: Target Pi. Builder Pi may
inspect the public Target harness and invoke typed AHDE operations, but it
cannot see private AHDE state, sealed data, raw credentials, or mutate the
repository directly. Target Pi never inherits Builder skills, sessions, tools,
or credentials.

```text
$ ahde
   |
   v
Builder Pi (conversation + Builder skills)
   |
   | trusted, typed AHDE extension tools
   v
AHDE core (artifacts + provenance + eval + gates)
   |
   | fresh process/session/workspace per task
   v
Target Pi (the harness under development)
```

This is harness engineering, not reinforcement learning. Improvement changes
versioned context, skills, and declarative tools; it never changes model
weights.

## Architecture decision

Use Pi twice, with two explicit trust domains.

| Concern | Builder Pi | Target Pi |
| --- | --- | --- |
| Purpose | Build and improve the agent | Execute the agent under test |
| Lifetime | Long-lived operator session | Fresh isolated session per task |
| Instructions | Packaged `builders/ahde/AGENTS.md` | Target `AGENTS.md` |
| Skills | Packaged Builder skills only | Manifest-declared Target skills only |
| Tools | Trusted AHDE extension only | Built-ins plus manifest-declared subprocess tools |
| Config/session root | Private Builder directory | Per-run private directory |
| Repository writes | Never directly | Scratch/worktree only under execution policy |
| Private state | Typed AHDE tools expose bounded views | Never visible |
| Sealed corpus | Never model-visible | Used only by the sealed evaluator |
| Human decisions | Host UI creates an approval grant | No promotion authority |

The architectural seam is:

```text
Builder Pi host
  <-> trusted AHDE extension
  <-> deterministic AHDE application/core modules
  <-> isolated Target Pi runtime
```

Do not add generic `BuilderHostAdapter` or `TargetRuntimeAdapter` interfaces
until a second concrete host requires them. Existing one-shot Pi/Codex/Claude
proposal adapters remain optional compatibility surfaces, not the primary UX.

## Builder Pi host

Bare `ahde` calls the exported Pi `main()` and supplies an inline trusted AHDE
extension. It starts with:

- built-in tools disabled;
- ambient extensions, skills, context files, and prompt templates disabled;
- only packaged AHDE Builder skills explicitly loaded;
- an exact packaged Builder system prompt;
- private Builder config and session directories under AHDE state;
- no generic shell, edit, or write capability.

Builder skills are product workflows rather than hidden control planes:

```text
builders/ahde/
  AGENTS.md
  skills/
    design-agent/SKILL.md
    design-evals/SKILL.md
    run-diagnose/SKILL.md
    improve-harness/SKILL.md
```

The extension exposes narrow tools grouped by intent:

- project: status and bounded public Target reads;
- spec: list, inspect, save draft, approve;
- corpus: list, inspect, save draft, publish development corpus;
- evaluation: run, list, summarize, diagnose, open evidence;
- improvement: author proposal, inspect exact diff, apply to candidate;
- candidate: verify, review, promote, or reject.

Tool responses are bounded structured summaries plus immutable IDs. Large
traces and reports stay outside model context and are linked through the local
evidence UI.

## Human authority

Consequential tool schemas never accept `actorId`, `approved`, `confirmed`, or
equivalent model-controlled fields.

For approve, publish, apply, promote, and reject:

1. Builder requests the operation using an immutable subject ID.
2. The extension reloads the subject and computes the exact hash/diff.
3. The host renders the exact operation, paths, and hash to the operator.
4. `ctx.ui.confirm` creates a local, operation-scoped, one-use approval.
5. The core revalidates the subject immediately before the mutation.
6. A durable receipt records the locally derived actor, subject hash, reason,
   and timestamp.

Headless/print mode fails closed. An approval cannot be replayed, transferred
to another operation, or used after the subject changes.

## Target Pi runtime

Interactive Target sessions and evaluation tasks use one Target runtime
factory. Every task receives a fresh session directory and a confined
workspace. Target resources are loaded explicitly from the committed harness;
Builder resources are never inherited.

The initial Target skeleton is:

```text
manifest.yaml
AGENTS.md
skills/<skill>/SKILL.md
tools/<tool>.tool.yaml
bin/<tool>
evals/development.jsonl
evals/graders.yaml
.gitignore
```

V1 declarative tools are subprocess descriptors, not arbitrary JavaScript or
TypeScript imported into the AHDE process. A descriptor contains:

- name and description;
- JSON Schema parameters;
- an argv array with no shell interpolation;
- timeout and output byte limits;
- network, environment, and filesystem permissions.

Input is JSON on stdin. Output is bounded JSON or text on stdout. The broker
validates arguments, resolves the executable inside the Target, applies the
execution policy, records tool-call trace spans, and returns a structured
error on timeout, policy denial, malformed output, or overflow.

The sorted tool descriptors and executable content hashes are part of Target
identity and run provenance. A run that lacks an enforceable sandbox is
recorded honestly as unconfined and cannot become promotable evidence.

## Canonical development loop

```text
rough intent
  -> Spec draft -> human approval
  -> development corpus draft/import -> human publish
  -> baseline Target runs
  -> deterministic diagnosis + evidence links
  -> typed proposal + exact diff
  -> human apply into candidate worktree
  -> development comparison
  -> sealed holdout comparison
  -> human review
  -> human promotion or rejection
  -> next immutable harness version
```

JSON/JSONL artifacts are canonical. HTML is a rebuildable read-only projection.
An inconclusive or infrastructure-failed evaluation cannot seed a proposal or
promotion. Sealed examples, expected outputs, and traces never enter Builder
Pi context.

## Evidence explorer

The localhost web surface is an evidence explorer, not a second mutable
control plane. It provides:

- eval and candidate summaries;
- failure-family clusters and representative runs;
- task/run/trace/span drill-down;
- exact provenance and resource hashes;
- links copied by Builder Pi after `/run`;
- bounded rendering with explicit omission notices.

All state-changing actions remain in Builder Pi and require the host-owned
human gate.

## Implementation plan

### P0 — Establish a trustworthy baseline

- Replace time-dependent test constants with one injected monotonic test clock.
- Record this two-Pi decision and delete the superseded Workbench/TUI path.
- Keep existing immutable Spec, Corpus, Eval, Diagnosis, Proposal, Candidate,
  and promotion modules as the deterministic core.

Acceptance: typecheck and the existing suite pass without future-dated clocks.

### P1 — Ship the real Builder Pi shell

- Add `src/builder/runtime.ts`, `src/builder/extension.ts`, and bounded project
  context helpers.
- Add the packaged Builder prompt and four Builder skills.
- Make bare `ahde` launch Pi `main()` with isolated roots and explicit assets.
- Preserve scriptable subcommands and optional one-shot proposal adapters.
- Add tests that capture registered tools and prove dangerous schemas contain
  no model-authored authority fields.

Acceptance: a packed install starts Builder Pi; it has only AHDE tools and
Builder skills; non-interactive consequential calls fail closed.

### P2 — Complete Target Pi as a harness runtime

- Extract one Target runtime factory used by interactive and eval execution.
- Add declarative tool manifest parsing, content hashing, and a confined
  subprocess broker.
- Add a working Target template tool and golden test.
- Include tool identity and effective sandbox state in provenance.

Acceptance: Target Pi can call a manifest tool during an eval, cannot access
Builder/private/sealed sentinels, and produces reproducible provenance.

### P3 — Close the Builder-driven loop

- Bind the extension tools to existing Spec/Corpus/Eval/Diagnosis/Proposal and
  Candidate application services.
- Add direct Builder-authored typed proposal recording so the primary Builder
  does not spawn a nested Builder Pi.
- Implement exact-diff approval and candidate verification/review gates.
- Add a golden natural-language flow with Pi tool calls; no regex intent
  parser may participate.

Acceptance: a user can go from intent to a promoted harness version without a
direct repository edit, and every transition has immutable provenance.

### P4 — Make evidence inspectable

- Reduce the Studio surface to GET/read-only evidence routes.
- Add eval/candidate indexes and trace drill-down links.
- Keep rendering bounded and escape all model-authored content.
- Return stable localhost URLs from Builder evaluation tools.

Acceptance: every failure summary links to its exact verified trace; browser
actions cannot mutate canonical state.

### P5 — Harden and distribute

- Keep V1.1 eval execution sequential and deterministic; add bounded concurrency
  only after measured runtime pressure justifies another scheduling surface.
- Split giant modules only where the new seams make behavior clearer.
- Enforce package size/file budgets and packed-install smoke tests.
- Run unit, integration, isolation, approval-replay, golden-flow, and package
  verification in CI.

Acceptance: clean install, scaffold, Builder startup, Target tool eval, full
candidate flow, and evidence navigation all pass from the packed tarball.

## Required acceptance matrix

- Builder and Target use different config, session, workspace, skills, tools,
  and environment sentinels.
- Builder cannot read `.ahde`, `runs`, sealed corpora, `.env`, or `.git`.
- Target cannot read Builder config/sessions or sealed evaluator material.
- Ambient Pi skills/extensions/context files never load into either runtime.
- Declarative tools reject path escape, shell interpolation, undeclared env,
  network-policy violation, timeout, oversized output, and malformed JSON.
- Approvals reject replay, stale subject hash, wrong operation, wrong subject,
  absent UI, and model-supplied actor/approval fields.
- Inconclusive evals cannot create canonical remediation proposals.
- An unconfined run is visible but non-promotable.
- A natural-language Pi conversation completes the golden loop without a
  regex command parser.
- Packed-install verification exercises shipped Builder assets and a Target
  tool call.

## NOT in V1.1

- RL, fine-tuning, reward models, or model-weight updates.
- Multi-runtime Target execution or Builder hosts other than Pi.
- Arbitrary Target JavaScript/TypeScript extensions loaded into AHDE.
- Autonomous apply, promotion, merge, deployment, or self-modification.
- Cloud tracing, teams, auth, billing, marketplace, or distributed runners.
- OTLP infrastructure or a third-party tracing platform dependency.
- Patching Pi internals when its public `main()` and extension APIs suffice.
- Windows support in the initial local-first release.

## GSTACK REVIEW REPORT

### Runs

| Review | Status | Material conclusion |
| --- | --- | --- |
| `plan-eng-review` | COMPLETE | Two isolated Pi runtimes; one Target runtime factory; staged P0–P5 delivery |
| `improve-codebase-architecture` | COMPLETE | Delete the shallow Workbench abstraction; use Pi directly; keep AHDE core deep |
| `thermo-nuclear-code-quality-review` | COMPLETE | STOP-SHIP until authority, isolation, tool provenance, and sandbox claims are fail-closed |

Architecture review artifact:
`/var/folders/qc/vpt0wq8x12z8r8gr53hlww1c0000gn/T/architecture-review-20260826T120746Z.html`

### Status

- Blocking decisions resolved: Pi is both Builder engine and Target engine,
  but never the same runtime instance or trust domain.
- Primary UX resolved: Builder Pi authors through trusted AHDE tools; nested
  one-shot builders are compatibility only.
- Web role resolved: read-only evidence projection.
- V1 Target extensibility resolved: declarative confined subprocess tools.

### Findings resolved by this plan

- The bespoke Workbench/TUI is removed instead of deepened.
- Human authority is removed from model-controlled tool parameters.
- Target tools become executable and hash-anchored, not merely allowed paths.
- Promotion depends on honest effective sandbox provenance.
- Builder and Target resources, sessions, and credentials are explicitly
  separated.

**VERDICT: PASS — READY FOR IMPLEMENTATION**
