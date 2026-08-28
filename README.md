# AHDE — build, evaluate, and improve Pi agent harnesses

AHDE turns a rough agent idea into a reviewed, testable harness without
training model weights:

```text
intent -> Spec -> Target harness + eval corpus -> runs + diagnosis
       -> proposal -> candidate experiment -> human promote or reject
```

Bare `ahde` opens a real, long-lived **Builder Pi**. You describe the agent in
ordinary language; Builder Pi structures the Spec, helps assemble evaluation
cases, runs and diagnoses the agent, and proposes bounded changes to its
instructions, skills, and tools.

The agent being built is a different **Target Pi**. It runs in fresh sessions
with only the Target resources and capabilities declared by its harness.

```text
$ ahde
   |
   v
Builder Pi (conversation + packaged Builder skills)
   |
   | trusted, typed AHDE tools
   v
AHDE core (immutable artifacts, provenance, evals, human gates)
   |
   | fresh session + isolated workspace per task
   v
Target Pi (the harness under test)
```

There is no RL, fine-tuning, or autonomous self-promotion. AHDE improves
versioned context and capabilities, not model weights.

## Start locally

AHDE requires Node.js 22.19 or newer.

```bash
npm ci --ignore-scripts
npm run build
mkdir my-agent
cd my-agent
../dist/cli.js                 # describe the agent; guided setup happens here
```

When AHDE is installed globally or linked, the last command is simply:

```bash
ahde
```

A typical Builder conversation looks like:

```text
> Хочу собрать агента для ...
Builder: Давай уточним пользователей, задачи и ограничения…
Builder: Spec готов. Утвердить?

> Запусти тесты
Builder UI: AHDE run 7/40 · tool search ✓
Builder UI: open live trace · http://127.0.0.1:.../live/...
Builder: 34/40 passed. Нашёл 3 системных failure mode.
Builder: Open verified development traces: http://127.0.0.1:...

> Исправь первую проблему
Builder: Подготовил Proposal для AGENTS.md и skills/search.
Builder: Показываю точный diff для подтверждения.
```

The same loop has compact Pi commands:

```text
/help                   AHDE workflow and shortcuts
/doctor                 Builder authentication and Target readiness
/status                 current stage and legal next actions
/run [repetitions]      run the selected development eval or candidate check
/traces                 diagnosis and read-only localhost trace link
/review                 exact Spec, corpus, proposal, or candidate under review
/apply <branch>         human-gated application of the exact proposal
/discard                discard a proposal or abandon an interrupted candidate
/target                 exact Target summary and standalone launch command
```

`ahde resume` reopens the private Builder session selector. The embedded Pi
host cannot import, export, share, trust, or execute shell commands; those
built-ins are removed before autocomplete and dispatch.

Builder Pi has no generic shell, edit, or write tool. It can act only through
the packaged AHDE tools, which expose bounded views and call the deterministic
application core.

While `/run` or a natural-language Workbench decision is executing, Builder Pi
shows one bounded provisional widget with run position, assistant messages,
and tool spans. The stream is credential-redacted, development-only, and
host-UI-only: it never becomes Builder model context or promotion evidence.
The widget always clears on completion, cancellation, or failure. Direct
`ahde run` callers receive compact run counters on stderr while the existing
final stdout remains stable.

The model-facing control surface is intentionally only three deep operations:

- `ahde_workbench_view` reads the restart-safe stage and bounded evidence;
- `ahde_workbench_submit` authors drafts, revisions, semantic Harness intents,
  or an explicit selection without granting authority;
- `ahde_workbench_decide` requests one stage-legal transition through the
  trusted human gate.

The Workbench derives state from validated immutable artifacts and receipts.
Its small atomic `focus.json` only resolves an explicit selection; it cannot
manufacture an approval, corpus lineage, proposal decision, or candidate
outcome.

## What gets built

Guided setup (or the scriptable `ahde init`) creates one generic Target Pi
harness and its initial Git revision:

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

The built-in template includes `echo_json`, a complete declarative Target tool.
A tool descriptor defines:

- a name, description, and strict JSON Schema for parameters;
- a static argv array with no shell interpolation;
- JSON input on stdin and bounded JSON or text output on stdout;
- timeout and maximum output size;
- explicit environment, network, and filesystem permissions.

Descriptors and executable bytes are hashed into `toolsetHash`. At execution,
AHDE reloads and verifies that identity, scrubs the environment, applies the
declared policy, records tool spans, and fails closed when a required sandbox
cannot be established. Arbitrary Target JavaScript or TypeScript is never
imported into the AHDE process.

The scaffold intentionally starts with a placeholder model. On the first
Builder session, describe the exact Target model you want. Builder Pi shows the
complete non-secret `manifest.yaml` diff and the host makes a one-time bootstrap
commit after confirmation. The credential value is never accepted by a Builder
tool: set only the API key named by the confirmed `model.apiKeyEnv` through the
trusted host environment. You can then validate without making a model call:

```bash
ahde validate --target .
```

To talk to the built agent itself, launch a separate disposable Runtime Pi:

```bash
ahde target
ahde target --message "Start with this task"
# Or select a different Target explicitly:
ahde target --target ../another-agent
```

Without `--target`, AHDE uses the current directory. This is not Builder Pi in
another mode. AHDE starts it in a dedicated child
process with a hash-checked workspace snapshot, manifest-declared skills and
tools, an in-memory session, and a private credential store. Its Node loader
starts without inherited environment; selected credential, runtime allowlist,
and fixed display/locale values arrive only over post-startup IPC. Interactive
shell escapes and ambient session/import switching are disabled. Nothing from
this conversation becomes canonical eval evidence.

## The canonical loop

Builder Pi uses four packaged workflow skills:

- `design-agent` turns rough intent into a typed Spec draft;
- `design-evals` builds a reviewable development basket;
- `run-diagnose` evaluates Target Pi and groups failure modes;
- `improve-harness` prepares and verifies a bounded candidate change.

The durable loop is:

```text
Spec draft --human approve--> approved Spec
Spec-bound corpus revisions --human publish--> development Corpus + lineage
Target runs --> deterministic Diagnosis --> read-only evidence link
semantic Harness intents --> compiled exact Proposal --human apply--> candidate commit
matched development + sealed evaluation --> human review
review --human decision--> promoted immutable revision or rejection
```

Approve, publish, apply, review, promote, and reject are host-owned decisions.
Their tool schemas do not accept model-supplied `actor`, `approved`, or
`confirmed` fields. In interactive TUI mode AHDE reloads the subject, displays
the exact hash or diff, asks the operator, revalidates it, and writes a durable
receipt. Consequential calls fail closed outside an interactive TUI.

Corpus revisions are immutable and content-addressed. Publishing records both
the canonical Corpus receipt and an exact Workbench lineage binding approved
Spec, reviewed draft, and development dataset hash. A compatible EvalRun must
additionally match the current Target revision and suite hash. Structured
Harness authoring accepts semantic instruction/execution-policy/skill/tool
intents; only the host compiler chooses repository paths, file modes, hashes,
and unified diffs. There are no product presets for agent types. A request such
as “build a deep research agent” follows the ordinary Spec → eval → diagnosis
→ Proposal path; when evidence shows that network research is required, AHDE
proposes the exact policy, environment-variable names, descriptor, and
executable for human review and candidate verification.

Builder Pi can also import a bounded JSONL file from the project-local
`imports/` inbox into a new editable draft. The inbox is git-ignored and never
copied into Target Pi or evaluation workspaces. AHDE rejects all paths outside
that inbox, symlinks, traversal, private state/run paths,
unstable reads, oversized files, and malformed tasks; caller-owned task ids are
discarded and an immutable source path/hash receipt is recorded and revalidated
after restart. Graders can be edited independently with `grader.add`,
`grader.update`, and `grader.remove` (or replaced as a bounded set with
`set-graders`). After a development failure, Builder
can use `add-case-from-run` to author a genuinely new neighboring regression
case. AHDE accepts only exact hash-indexed failed development evidence from the
current Spec/Target/corpus lineage and persists bounded ids and hashes, never
the trace answer. Passing, infrastructure, foreign, candidate, duplicate, and
sealed sources fail closed.

## Evidence Explorer

After an evaluation, Builder Pi can return a localhost link to the exact
diagnosis and traces. You can also start the explorer explicitly:

```bash
ahde diagnose <eval-run-id>
ahde evidence
```

`/run`, `/traces`, the CLI, and this report all consume the same deterministic
Improvement Brief. New evidence is grouped only by an exact grader-check
fingerprint; a mode becomes systemic after it appears on at least two distinct
tasks. The report keeps counter-evidence, labels explanations as hypotheses,
and reserves a representative trace for each top mode. Infrastructure errors
leave the brief inconclusive and ineligible to steer a proposal.

The server binds to `127.0.0.1` and accepts only `GET` and `HEAD`. It renders
already-created canonical evidence; HTTP requests cannot run an eval, create a
diagnosis, apply a proposal, or make a decision. During a run started inside
the long-lived Builder, the same host also serves a random capability URL with
a bounded, redacted, memory-only SSE view. That URL is shown only in host UI,
is never listed, expires after 15 minutes, and disappears on restart.
The Builder repeats the capability URL after completion or failure so the
retained view remains reachable after its live widget is cleared.

Live `RunEvent` observations deliberately stay in process. AHDE does not write
a second event journal, tail mutable run directories through HTTP, or expose
sealed holdout progress. Browser text is inserted with `textContent`; Host,
Origin, CSP, same-origin resource policy, memory, frame, viewer, and TTL bounds
are enforced. The live page labels EvalRun ids as provisional rather than
linking to evidence before diagnosis exists. After completion, `/traces` links
to the existing hash-verified report built from canonical `session.jsonl` and
`run.json`.

Sealed holdout cases, graders, expected outputs, identifiers, and traces are
never shown to Builder Pi or the Evidence Explorer. The evaluator gives Target
Pi one sealed case at a time, and only bounded gate results cross that boundary.

## Scriptable commands remain available

The conversational Builder is the primary UX. Explicit commands remain a
compatibility and automation surface over the same application services:

```bash
# inspect and evaluate
ahde validate --target .
ahde run --target . --label baseline --repetitions 3
ahde list
ahde diagnose <eval-run-id>
ahde compare <baseline-eval-id> <candidate-eval-id>
ahde report <eval-run-id>

# manage versioned evaluation data
ahde corpus draft --target . --project my-agent \
  --spec <approved-spec-id> --tasks 12
ahde corpus publish --project my-agent --draft <draft-id> \
  --name "reviewed development basket" --visibility development
ahde corpus import --project my-agent --name "promotion holdout" \
  --visibility sealed --file ./private-holdout.jsonl

# optional one-shot Builder adapter compatibility
ahde builder capabilities --target .
ahde builder propose --target . --project my-agent \
  --spec <approved-spec-id> --eval-run <eval-run-id> --backend pi
ahde builder apply --target . --run <builder-run-id> \
  --branch candidate/<builder-run-id> --reason "Reviewed exact diff"

# exact candidate experiment and terminal human decision
ahde candidate --target . --builder-run <builder-run-id> \
  --project my-agent --development-corpus <development-corpus-id> \
  --holdout-corpus <sealed-corpus-id> --repetitions 3
ahde review --candidate <candidate-id> --recommend promote \
  --reason "Development improved and sealed gate passed"
ahde promote --target . --candidate <candidate-id> --to 0.2.0 \
  --reason "Ship the exact reviewed revision"
```

Pi, Codex, and Claude one-shot proposal adapters normalize only the typed
proposal contract. They are optional compatibility paths; they do not replace
the primary Builder Pi trust domain and AHDE does not pretend their internal
traces are identical.

## Evidence and promotion invariants

Each run records the exact Target Git revision, model and Pi runtime,
instructions, skills, toolset, dataset and suite hashes, effective environment,
sandbox result, traces, metrics, and graders. Infrastructure errors are
inconclusive, never silently converted into behavioral failures.

Candidate Experiment:

1. resolves immutable baseline and candidate SHAs;
2. rejects lineage and file-scope violations before model calls;
3. creates detached worktrees without switching the user's checkout;
4. runs matched task/repetition designs;
5. verifies execution and grading fingerprints;
6. computes paired task deltas and deterministic uncertainty;
7. persists one canonical `CandidateRecord`.

Only `AGENTS.md`, `skills/**`, `tools/**`, `bin/**`, and the `skills`/`tools`
declaration lists in `manifest.yaml` may change in a Builder proposal. Target
id, model, execution policy, instructions, eval suite, and `evals/**` remain
fixed. Promotion requires an applied proposal with a durable receipt,
comparable development evidence, evaluator-owned sealed evidence, honest
workspace confinement, an explicit human promote review, and the exact
candidate revision. A manual experiment or unconfined run cannot be promoted.

## Storage and trust boundaries

```text
<target>/
  manifest.yaml, AGENTS.md, skills/**, tools/**, bin/**, evals/**

<state-root>/projects/<project-id>/
  specs/**, builder-corpus-drafts/**, builder-corpus-imports/**, corpora/**
  approval receipts
  workbench/{focus.json,corpus-publications/**,candidate-abandonments/**}

<state-root>/builder-pi/
  config/**, sessions/**

<runs-root>/
  <run-id>/{run.json,session.jsonl,judge/**}
  <eval-run-id>/{eval_run.json,diagnosis.json,report.html,...}
  builders/<builder-run-id>/**
  candidates/<candidate-id>/candidate.json
```

Builder and Target are separate Pi invocations with different system prompts,
skills, tools, session/config roots, workspaces, and credentials. Builder may
inspect only bounded public harness files through AHDE tools. Target never sees
Builder state or evaluator-owned sealed storage. AHDE resolves exactly the
confirmed Target credential in the host and injects only that value into an
in-memory provider store; Target Pi cannot resolve arbitrary ambient secrets.
Every task in one EvalRun is copied from the same hash-checked source snapshot,
and that exact workspace hash is persisted in both `eval_run.json` and every
member `run.json`. A dirty or concurrently changing checkout therefore cannot
silently masquerade as the committed Git SHA or be reused as another baseline.

Durable artifacts are strict, schema-versioned, size-bounded, atomically
written, and validated again on read. Immutable evidence uses exclusive
publication. Sealed means workflow-hidden and evaluator-owned; it is not a
claim of encryption against the local machine owner.

## Verify the shipped product

```bash
npm run check
npm run demo
npm run verify:package
```

`npm run demo` exercises the production-shaped improvement loop with a local
scripted OpenAI-compatible model, so it uses no paid tokens.

`npm run verify:package` tests the artifact an npm user actually receives. It
packs AHDE under size/file budgets, installs the tarball into an empty consumer,
scaffolds and validates a Target, starts the isolated Builder host, executes the
template's declarative `echo_json` tool through the OS sandbox, and exercises
both canonical reports and a capability-scoped live SSE feed over a real
loopback HTTP socket. The separate
natural-language acceptance test drives a real Builder Pi model/tool session
through Spec, eval, Proposal, sealed verification, review, and promotion. The
package gate also rejects stale Studio, companion, and retired Workbench-TUI
files.

## Architecture

| Module | Owns |
|---|---|
| `src/builder/runtime.ts` | isolated long-lived Builder Pi host |
| `src/builder/extension.ts` | Workbench tools, compatibility tools, and TUI gates |
| `src/builder/commands.ts` | Pi-like workflow and decision shortcuts |
| `src/builder/project-context.ts` | bounded public Target/evidence views |
| `src/application/**` | deterministic Spec/Corpus/Proposal/Candidate use cases |
| `src/workbench/**` | restart-safe orchestration, state derivation, and legal transitions |
| `src/target/runtime.ts` | the single Target Pi construction seam |
| `src/target/interactive.ts` | dedicated disposable interactive Runtime Pi process |
| `src/target/tool-manifest.ts` | declarative tool validation and identity |
| `src/target/tool-broker.ts` | confined subprocess execution |
| `src/run-events.ts`, `src/builder/run-progress.ts` | bounded development-only live observation and TUI projection |
| `src/runner.ts`, `src/eval.ts`, `src/trace.ts` | isolated execution and evidence |
| `src/diagnosis.ts`, `src/application/improvement-brief.ts` | task evidence and exact-signature failure modes |
| `src/report.ts`, `src/evidence/server.ts` | bounded read-only evidence projection |
| `src/application/candidate-experiment.ts` | exact matched candidate evaluation |
| `src/application/candidate-review.ts` | review, rejection, and promotion authority |

See [CONTEXT.md](CONTEXT.md) for domain language and invariants,
[docs/V1_2_BUILDER_WORKBENCH.md](docs/V1_2_BUILDER_WORKBENCH.md) for the
implemented Builder Workbench, and
[docs/V1_3_RUN_EVENTS.md](docs/V1_3_RUN_EVENTS.md) for the live observation
contract,
[docs/V1_4_SYSTEMIC_DIAGNOSIS.md](docs/V1_4_SYSTEMIC_DIAGNOSIS.md) for the
evidence-backed failure-mode contract, and
[docs/V1_1_WORKBENCH_PLAN.md](docs/V1_1_WORKBENCH_PLAN.md) for the historical
two-Pi plan it supersedes.

## Deliberately out of scope

- RL, fine-tuning, reward models, or model-weight changes.
- Autonomous apply, promotion, merge, deployment, or self-modification.
- A mutable browser control plane, hosted tracing, teams, auth, or billing.
- Arbitrary Target code imported into the AHDE process.
- Multi-runtime execution, distributed runners, Kubernetes, or OTLP plumbing.
- Windows support in the initial local-first release.
