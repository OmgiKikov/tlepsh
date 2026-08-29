# AHDE V1.7 — Product Surface

V1.2–V1.6 built the deep modules: immutable artifacts, receipts, exact
evidence, human gates. V1.7 makes that machinery feel like a product without
loosening any of it. The rule for this milestone: **no new schema without a
screen that renders it**, and no screen that shows raw JSON to a human.

## Definition of done

A new user, without documentation, runs `ahde` in an empty directory, connects
a model once, describes the agent in plain language, sees the Spec, the eval
basket, a run, its diagnosis, an exact diff, accepts the candidate, makes it
the active agent, and continues the next cycle after a restart. Every step is
visible in the terminal as a rendered block, never as a JSON dump.

## What changed

### One login for every project

Builder credentials and Pi settings live in `~/.ahde/builder-pi/config`
(`AHDE_HOME` overrides the root). Per-project state stays in `<project>/.ahde`
(sessions, Workbench focus, receipts). Legacy per-project `auth.json` and
`models.json` are copied once, never overwritten. Pi's own startup listing is
silenced (`quietStartup`), and its changelog version is pinned to the vendored
Pi so an AHDE upgrade never shows Pi's "What's New" inside the Builder.

### First run is two answers, not a checklist

On `session_start` the product shell reads the Workbench and:

1. without a Builder credential: one selector → `/login` or `/model`
   pre-filled in the editor;
2. in an empty directory: "Create the agent here?" — the answer is the
   confirmation; the Workbench still records the scaffold receipt;
3. with a placeholder model: "Which model should the agent itself use?" with
   the Builder's model first; the credential environment variable is asked
   only when it is not already set. The bootstrap commit and receipt are the
   same as before.

Then the header reads `Stage Spec design · Next Describe the agent`, and the
conversation is the product.

### A live header

`src/builder/product-shell.ts` keeps one header component whose state is
re-read after every tool execution, agent turn, model change, and slash
command (coalesced, so bursts cost one inventory read). It shows Target,
revision, Target model and whether its credential is present, stage, the next
step in imperative form, evidence counts, and the Builder model. Every line is
truncated to the viewport with ANSI awareness because Pi aborts a session on
an over-wide custom line.

### Typed detail, human renderers

`WorkbenchView.detail` is a discriminated union
(`WorkbenchReviewDetail | WorkbenchTracesDetail | WorkbenchTargetDetail`),
`WorkbenchDecisionResult` is keyed by decision kind, and `decide()` has typed
overloads. `src/builder/render/**` renders every kind for humans:

| Renderer | Shows |
|---|---|
| `renderStatus` / `renderHeader` | stage, next step, target, evidence, readiness |
| `renderReview` | Spec draft, eval basket, proposal diff, applied proposal, candidate (with impact), interrupted candidate |
| `renderTraces` | pass/fail bar, failure modes with decision hints, evidence link, next step |
| `renderTarget` | committed identity, execution policy, declared resources, one resource body |
| `renderDecision` | one block per decision kind (run summary, apply, promote, adopt, next cycle …) |
| `renderConfirmation` | what a confirmation does, in words, plus the exact subject hash |
| `renderImpact` | which targeted failure modes the candidate resolved, new modes, regressions |

Renderers take a `Paint` (theme-backed in the TUI, plain in tests) and pass
every artifact-authored string through `sanitizeTerminalText`.

### Transcript blocks the model never sees

Human output is appended as a custom session entry (`ahde-panel`) rendered by
a registered entry renderer. Entries persist across resume, redraw with the
live theme, and are never sent to the model. Lines are painted with
private-use markers (U+E000/U+E001) at append time and swapped for theme
colors at render time, so the persisted entry stays plain JSON. When the host
has no entry renderer (RPC, tests) the presenter falls back to a plain
notification.

Slash-command decisions additionally leave the model a hidden note
(`ahde-operator-note`, `display: false`) so the next turn knows what the
operator did outside the conversation.

The three Workbench tools render compact cards (`renderCall`/`renderResult`):
collapsed, one line with the headline and the new stage; expanded, the same
human rendering as the slash commands.

### Commands are shortcuts with actions

`/status /review /traces /run /approve /publish /apply /discard /promote
/reject /adopt /next /target /doctor /help`. `/review` renders the exact
subject and then offers its decisions as a selector ("Apply to a candidate
branch", "Discard", "Just looking"); `/traces` offers "Fix N: …" which sends
the request into the conversation. Errors are calm sentences: declined →
"Cancelled — nothing changed."; stale → "run the command again"; selection
required → the choices.

### One human intent, one dialog

`/promote <version>` at candidate review records the review and the
promotion as two receipts behind one confirmation: the intent gate
pre-approves the follow-up only for the same candidate id inside the same
command invocation. `/reject` mirrors it. A single sealed holdout is selected
without a picker; the following confirmation still shows its size.

### The loop closes

Two new decisions and one new stage:

- `candidate-adoption` → `adopt-candidate`: fast-forward the operator's
  current branch from the candidate baseline to the promoted revision
  (`src/application/target-adoption.ts`), receipt under
  `<state-root>/target-adoptions/<candidate>/`. The promoted harness becomes
  the active Target for `ahde target` and the next cycle.
- `complete` → `continue-cycle`: record the closed loop
  (`src/workbench/cycle-continuation.ts`, receipt under
  `<state-root>/projects/<project>/workbench/cycle-continuations/<candidate>/`),
  release the candidate from focus, and let the Workbench derive the next
  stage from the active Target: usually `ready-to-evaluate` after adoption,
  or `improvement-authoring` after a rejection.

Inventory verifies both receipts against the exact candidate record hash; a
receipt that no longer binds its candidate blocks the Workbench. A finished
candidate holds the stage from artifacts alone — selecting another artifact
cannot skip adoption or closure; several open finished candidates require an
explicit selection first.

### Live runs

The `/run` widget status reads
`AHDE run 7/40 ████░░░░░░░░ 18% · ✓5 ✗1 · task-id · tool search`, and the
post-run block shows the pass bar, failure modes ranked with their decision
hint, the evidence link, and the next step.

### Sessions

`ahde` starts a new conversation, `ahde continue` reopens the most recent
one, `ahde resume` opens the picker. Workflow state is durable regardless.

### Builder persona

`builders/ahde/AGENTS.md` now leads with how to work with the operator (one
question at a time, defaults over questions, human vocabulary, no hashes in
conversation) and a vocabulary table; the evidence rules and the typical loop
follow unchanged in substance, extended with adoption and continuation.

## Invariants added

31. Promotion never moves the active Target. Adoption is a separate
    human-confirmed fast-forward of a clean worktree from the exact candidate
    baseline to the exact promoted revision, with an intent and a receipt that
    bind the candidate record hash.
32. A terminal candidate leaves focus only through an explicit continuation
    receipt; a promoted candidate requires its adoption receipt first. The
    next stage is derived from artifacts, never from the closed candidate.
33. Human-facing rendering is downstream of every decision: a renderer fault
    degrades to the Workbench message and never changes durable state.

## What live models taught us

Real Builder sessions through OpenRouter (GLM-5.3, Claude Sonnet 4.5) drove
three changes that scripted tests could not have found:

- **Models send nested JSON as strings.** Both models passed `spec`, `tasks`,
  and `graders` as JSON *strings* at least once. `prepareWorkbenchArguments`
  (Pi's `prepareArguments` hook) parses such strings wherever the schema
  expects an object or array, picks the branch the model chose by its
  discriminator, and reports problems the way a model can act on: unknown
  properties with the allowed list and a "did you mean", missing required
  fields, and unsupported `type`/`kind` values with every allowed variant and
  its fields. The raw TypeBox union dump made one model loop fifteen times.
- **Skills were invisible.** Pi lists skills in the system prompt only when
  the model has a `read` tool, and the Builder deliberately has none, so the
  four packaged workflow skills never reached the model. They are now inlined
  into the system prompt (`composeBuilderSystemPrompt`), and the three tool
  descriptions carry a compact contract: every `kind`, the task and grader
  shapes, the intent shapes. This is also how Target tools get written — as
  `tool.upsert` intents compiled and reviewed by the host — so the Builder
  needs no `write` tool.
- **Unrunnable graders must fail early.** A Python-style `(?is)` regex or a
  `judge` grader on a Target without a judge model used to surface as a
  lineage integrity failure after publication and block the Workbench.
  Graders are validated against the current Target before any draft or
  publication persists, and composition failures are compatibility warnings.

## Known gaps

- Conversation quality still depends on the Builder model; tool-call
  reliability varies by provider (GLM-5.3 via OpenRouter emitted empty
  tool-call arguments after long reasoning). Prefer a model with robust tool
  calling for the Builder.
