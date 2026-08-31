# AHDE Roadmap — V2: measure, then improve, then integrate

Status 2026-08-30. Branch `v2-measurement` (off master `9973bad`). This
supersedes the "after V1.8" ordering; the old item numbers are mapped to waves
in the appendix so earlier references still resolve.

AHDE is stage 2 of an internal platform: Pi is the runtime (stage 1); AHDE
creates an agent's harness, evaluates it, and improves it through evidence.
The order below is deliberate: every later item is validated by the first
wave, and the platform needs stable seams, not a moving loop.

## Why this order — what we checked (2026-08-30)

In 2026 "harness engineering / harness optimization" became a field. The
sources that shaped this roadmap:

- [Meta-Harness](https://arxiv.org/abs/2603.28052) (Mar 2026): an agentic
  proposer that reads source, scores, and traces of *all* prior candidates.
- [SkillOpt](https://arxiv.org/abs/2605.23904) (May 2026): bounded
  add/delete/replace edits to skill documents, accepted only when they
  strictly improve a held-out score; +19–25 pp on GPT-5.5 across chat, Codex
  and Claude Code; beats GEPA and TextGrad. This is AHDE's proposal shape.
- [Do Agent Optimizers Compound?](https://arxiv.org/abs/2607.14004)
  (Jul 2026): on Terminal-Bench 2.0 gains compound only when regression
  control is inside the optimization loop. This is AHDE's sealed guardrail.
- [Better Harnesses, Smaller Models](https://arxiv.org/abs/2607.08938)
  (Jul 2026): a small model with an adapted harness recovers 89.7% of a large
  model's performance at 4% of the cost; adaptations are discovered from
  failure trajectories. The ombudsman result (9B model, 40% → 96%) is this
  experiment, not a toy.
- [Harness-R1](https://arxiv.org/abs/2608.02276), [SBCO](https://arxiv.org/abs/2608.10157),
  [Recursive Harness Self-Improvement](https://arxiv.org/abs/2607.15524),
  [Adaptive Auto-Harness](https://arxiv.org/abs/2606.01770),
  [GEPA](https://arxiv.org/abs/2507.19457) (ICLR 2026 oral; Pareto
  population, 100–500 evaluations per optimization).
- [Catching One in Five](https://arxiv.org/abs/2606.10315) (Jun 2026): a
  production LLM judge caught 22% of confirmed problems — "a regression floor,
  not a substitute for human review". [Time to REFLECT](https://arxiv.org/abs/2605.19196):
  judges below 55% on failure detection.
- [Nubank, KDD '26](https://arxiv.org/abs/2606.08867): evaluation-driven
  support agents at 100M users; LLM judges with measured inter-rater
  agreement; GEPA for consistency; "evaluation-pipeline quality directly
  determines iteration velocity".
- Anthropic: [error bars](https://www.anthropic.com/research/statistical-approach-to-model-evals)
  (paired differences, resampling, power), [Demystifying evals](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  (20–50 tasks from real failures; calibrate rubrics against humans; read
  transcripts), [Infrastructure noise](https://www.anthropic.com/engineering/infrastructure-noise)
  (infra errors swing scores by 6 pp; differences under 3 pp deserve
  skepticism), [skill-creator evals](https://agentskills.io/skill-creation/evaluating-skills)
  (with/without, blind A/B, LLM proposes the diff, human applies).
- [OpenAI harness engineering](https://www.infoq.com/news/2026/02/openai-harness-engineering-codex/)
  (Feb 2026); OpenAI Agent Builder + Evals are being shut down (Evals
  read-only 2026-10-31, gone 2026-11-30): the hosted visual builder lost;
  code-native, git-native loops survive.
- [autoresearch](https://github.com/karpathy/autoresearch): the loop
  (edit → bounded run → metric → keep/revert) is the product.
- Pi 0.84.4 (2026-08-28) is plumbing-only relative to the vendored 0.84.3;
  `packages/evals` exists but is undocumented and not a product. Nobody ships
  the full AHDE combination (builder agent + author-hidden holdout +
  paired-bootstrap/A-A gate + git-tag promotion).

Where AHDE stands against practice (verified 2026-08-30):

| Ahead | Behind |
|---|---|
| paired per-task bootstrap with a three-way verdict + sealed guardrail (Inspect added a single-run `ci()` only in Aug 2026) | judge–human agreement (LangSmith Align, Ragas `judge_alignment`, Inspect `krippendorff_alpha`) |
| A/A calibration — no other tool has it | simulated user (Harbor `--user-agent`, τ²-bench, DeepEval simulator) |
| holdout hidden from the optimizer — nobody enforces it | ~~multi-candidate search (GEPA, Meta-Harness, SkillOpt)~~ — landed as `ahde search` / `improve --candidates N` |
| infrastructure error budget, immutable provenance, git-tag promotion | partial credit, cost/latency in the verdict, regrade without rerun (Harbor `regrade`), semantic failure clustering, CI plumbing |

## Now vs. after — the operator's experience

| | Now (master 9973bad) | After wave 1 | After wave 2 | After wave 3 |
|---|---|---|---|---|
| Gates | 7 dialogs: approve, publish, apply, review, promote, adopt, next | 3: start testing · apply a change · ship | same | same, plus a web gate for the platform |
| Verbs | 14 slash commands, stage names in the header | `/test` `/fix` `/ship`; header says the next verb | `ahde improve` runs cycles by itself | headless API |
| Judge | a rubric the Builder wrote; nobody checked it | assertion checklists, a jury of 3, `ahde label`, agreement shown next to every judge verdict | — | — |
| Changing a rubric | rerun everything (135 runs) | `ahde regrade`: re-score recorded answers | — | — |
| Score | binary pass/fail per run | mean grader score; cost and latency beside the interval | — | — |
| Trying a fix | one proposal → full verification | — | `ahde check` screens the failed cases first; `ahde improve` runs the cycle; `ahde search` / `--candidates N` puts 2–4 candidates in a Pareto table | — |
| Proposer memory | sees the current failures and nothing else | — | reads what was already tried and refuses to re-run a losing experiment | — |
| Builder's hands | semantic intents compiled by the host | — | **done** — edits files in a bound worktree, runs the tool it wrote; the proposal is the diff | — |
| Chat agents | seeded history, grade the next reply | — | simulated user with a goal and persona | — |
| Target sandbox | best-effort sandbox-exec/bwrap for `bash` | — | — | **Docker landed** (`execution.container`, always pinned by digest); Gondolin behind the same interface |
| Docs | 27 KB README, 35 invariants | — | — | one-page README with a real transcript; ~15 invariants |

## Wave 1 — measurement you can trust (in progress)

Four lanes in worktrees off master, merged into `v2-measurement` after
`npm run check`, `npm run demo`, `npm run verify:package` are green.

1. **regrade** — `ahde regrade <eval-run> --target . [--graders …]` re-scores
   the recorded traces of an eval run with new graders; no Target calls; a
   derived EvalRun with the same target/workspace/dataset axes and a new
   suite hash (`derivedFrom` / `regradeOf`). Regrade a baseline and a
   candidate with the same graders and they are comparable to each other.
2. **gate v4** — the comparison gate pairs per-task mean grader scores
   instead of pass rates (binary graders unchanged; fractional graders gain
   power); `exact-comparison-gate-v4`; cost, latency and token ratios are
   rendered beside every verdict, never gating.
3. **judge quality** — `judge` graders accept `assertions` (yes/no/unknown
   checklists; score = yes/total; stable failure-mode signatures per failed
   assertion index) and `jury` (n independent judge calls, majority);
   `ahde label <eval-run>` collects human pass/fail on a seeded sample without
   showing the judge's verdict first; `ahde judge-agreement` reports n,
   agreement rate and Cohen's κ per grader; reports and candidate reviews show
   `judge agreement 84% · κ 0.62 · n=50` or `judge not calibrated`; optional
   `evalSuite.judge.requireCalibration` refuses promotion on uncalibrated
   judge evidence.
4. **feel** — a gate policy: three consequential moments (`start-testing` =
   approve Spec + publish tests + run in one dialog; `apply-proposal`; `ship`
   = review + promote + adopt + continue in one dialog); routine decisions
   (run, calibrate, verify, regrade) execute without a dialog under a cost
   guard (ask once above `AHDE_ROUTINE_COST_USD` / `AHDE_ROUTINE_MINUTES`,
   estimated from history); `/test` `/fix` `/ship`; the persona acts instead
   of narrating stages; vocabulary in the operator's words.

Acceptance for the wave: all three verification commands green on the merged
branch; the closed-loop Pi test passes with exactly three confirmations.

## Wave 2 — the measured improvement loop

5. **Cheap check before the expensive one** — *landed*. `ahde check --target .
   --candidate <id>`, and `verify-candidate` runs it first: the candidate on
   only the cases the source eval recorded as failing, once, candidate arm
   only, against those cases' recorded outcomes. `flat` (nothing previously
   failing now passes) stops the verification until the operator forces it.
   The screen is never evidence: its eval run atomically carries `purpose:
   "screen"` (the `solo` label is not the trust boundary), every screen is
   recorded under `runs/screens/`, no comparison gate sees one, promotion
   refuses a candidate that cites one, and `add-case-from-run` refuses one as a
   source (old item 19).
6. **Population** — *landed*. `ahde search --target . --candidates <id,id,id>`
   and `ahde improve --candidates N` (1..4, default 1). One failure mode, 2–4
   already-authored hypotheses, each applied on its own
   `candidate/search-<searchId>-<n>`
   branch, each screened by the cheap check, and the full matched development
   verification paid only where the screen found something. The result is a
   Pareto table: verdict, score delta with its 95% interval, cost and latency
   ratios, the screen's numbers, and which candidates are dominated (another
   verified candidate at least as good on both score and cost and strictly
   better on one; exact ties break by candidate order). Only `improved`
   development verdicts enter the release frontier, which may honestly be
   empty. The whole search runs under one estimate and the existing `--jobs`
   pool; a flat screen and an exhausted budget are typed skip reasons the table
   names. Sealed verification is not part of the search: `proposalSearchGate`
   throws on every consequential decision and on the sealed picker, and the
   human picks one candidate that then meets the unchanged sealed gate and
   promotion (old item 8).
7. **Autoloop inside the gates** — *landed*. `ahde improve --target . --until
   90% --max-cycles 5 [--jobs N] [--project id]` and a consequential Workbench
   `improve` decision with one cost disclosure estimated over the whole
   planned loop: run → diagnose → top proposable failure mode → the next
   unapplied Builder proposal → apply on `candidate/auto-<loopId>-<n>` → cheap check →
   development verification when the screen is promising. It stops at the
   target pass rate, the cycle budget, a verdict other than `improved`, two
   flat screens in a row, an over-budget infrastructure error, or a verified
   candidate — because the sealed guardrail and the promotion are the human's.
   Authoring still needs Builder Pi: a headless authoring seam is wave 3 (#12).
   The ledger checkpoints spend and branches; `--resume` validates the exact
   Target/Spec/corpus/configuration and also reads Git refs after a crash. It
   stops at the first verified candidate: public compounding is withheld until
   one matched and sealed comparison can cover the full stack (old item 2).
8. **Promoted fixes become guards** — *landed*. A promotion derives the tasks
   that flipped fail→pass between its two development arms into one corpus
   draft revision, through the same exact-evidence rules the Builder's
   `add-case-from-run` goes through. It runs after the promotion receipt, is
   reported as `guards: { draftId, cases }`, degrades to a warning, and never
   publishes: the operator publishes that draft like any other (old item 4).
9. **Builder with hands** — *done.* `ahde_workshop_read` / `_write` / `_bash` /
   `_try` live inside one bound detached worktree confined to `AGENTS.md`,
   `skills/**`, `tools/**`, `bin/**`, `data/**`; the proposal is the worktree
   diff, compiled at `workshop-close` and admitted through the unchanged
   receipt, apply, verify and promote chain. The intent compiler stays as the
   fallback for single-file edits and remains the only path to
   `execution.configure` (`docs/V1_9_TOOL_WORKSHOP.md`, old item 0c).
10. **Simulated user** — a second model with a goal and persona for N turns;
    graders over the whole transcript (old item 0b).
11. **Host-side sealed generation** — an evaluator-model call whose output
    never enters the Builder's context; the human edits and seals (old item 3).

11b. **The proposer remembers what was already tried** — *landed*.
    [Meta-Harness](https://arxiv.org/abs/2603.28052) makes this the core of the
    method: a proposer that reads the scores of *every* prior candidate is what
    lets a search compound instead of wander. AHDE already stored it; nothing
    read it back. Now three surfaces do. `ahde_workbench_view` with
    `aspect: "history"` returns the bounded projection for the current Target
    and project (no hashes, no receipts, no sealed content, and a host renderer
    beside it). `aspect: "target"` — the authoring context the Builder reads
    immediately before it proposes — carries the newest attempts as
    `priorAttempts` plus `priorAttemptsOmitted`, inside its own byte budget and
    deliberately outside `contextHash` and the claim. And the autoloop refuses
    to re-propose a change whose changed-path set and targeted failure mode
    match an attempt that already ended `rejected` or non-`improved`, stopping
    with `experiments-exhausted` when every proposable mode is used up.

## Wave 3 — platform integration

12. **Headless mode** — the Workbench behind JSON-RPC/HTTP with an injected
    `WorkbenchHumanGate` (the platform's confirmation UI) instead of
    "RPC fails closed"; per-project state/runs roots on a server; Builder via
    Pi `--mode rpc`. The seams (`AhdeWorkbenchDependencies`, `gate.confirm`)
    already exist; this is an implementation, not a refactor.
    *Landed as `ahde serve` (`src/serve/**`): the Workbench behind a loopback
    HTTP/JSON API on `/v1/view`, `/v1/submit`, `/v1/decide`,
    `/v1/confirmations`, `POST /v1/confirmations/:id`, `/v1/events`, and
    `/v1/health`. The injected gate does not auto-approve — a consequential
    decision opens a pending confirmation bound to the exact host-minted
    subject hash and blocks until the platform answers that id with that hash;
    a wrong hash, an unknown id, a replay, an expiry and a shutdown are
    refusals. The actor is the API's own authenticated identity, never a
    request field. Remaining: the Builder itself over Pi `--mode rpc`, and
    per-project roots for a multi-project server.*
13. **Gondolin / Docker for the Target's built-in `bash`**; `sandbox: required`
    in the bank profile.
    *Docker backend landed (`src/target/container-backend.ts`). Declaring
    `execution.container: { runtime, image, platform, memoryMb?, cpus?,
    pidsLimit?, readOnlyRootfs? }` selects it — there is no second switch that
    could disagree with the block. The built-in `bash`, every declared tool and
    every declared `setup` step then run as*
    `docker run --rm --name <host-minted> --platform <os/arch> --network none|bridge --user <non-root> --cap-drop ALL
    --security-opt no-new-privileges --read-only --tmpfs /tmp --memory --cpus
    --pids-limit -v <workspace>:/workspace:ro|rw -v <scratch>:/scratch:rw
    -v <toolHome>:/tools:ro|rw -e … -w /workspace --entrypoint <argv0> <image>
    <argv…>`*, with an environment built from nothing —* `PATH` `HOME` `TMPDIR`
    `LANG` `TERM` *plus the declared allowlist, one* `-e NAME=value` *at a time;
    the host's environment is never inherited and no host path enters the
    container's argv, cwd or environment. Every container image is pinned as
    `name@sha256:…`, and its OCI platform is explicit; a mutable tag or
    host-native platform selection is refused because neither can identify
    comparable evidence. `sandbox: required` fails closed with the runtime's exact reason when no
    runtime answers the bounded version/OS/architecture probe (once
    per process, bounded); `best-effort` falls back to the host OS sandbox with
    a warning and a different fingerprint when the runtime is unavailable, so a
    fallback never masquerades as container evidence. `ahde validate` prints
    `sandbox: container (docker 27.1, server linux/arm64, target linux/arm64,
    image pinned)` or the fail-closed reason.
    Container start latency is part of the run's `latencyMs` — it is real.
    Timeout, abort, and output overflow force-remove the exact named container
    through the daemon before killing the attached CLI, so a bounded run cannot
    leave an unbounded orphan behind.*

    ***A container backend changes the execution fingerprint and therefore
    starts a new comparability class: existing host baselines are not reusable
    against it, by design.*** *`RunRecord.execution.sandbox` now carries the
    content-pinned value* `container:<runtime>@<image digest>:config:<hash>`*,
    where the hash binds platform, limits, rootfs mode, non-root user and runtime
    server identity, through the same `effectiveTargetSandbox`
    seam used by ordinary runs and Candidate preflight. Container evidence is
    classified* `workspace-confined-v1` *and can be promoted; a host fallback
    keeps the host backend's identity and cannot masquerade as container
    evidence. Gondolin remains behind the same `ContainerBackend` interface;
    its stub fails closed and nothing is vendored.*
14. **Ceremony cut** — receipts only at approve/publish/apply/promote/adopt;
    inventory cached by mtime; README to one page with a real transcript;
    CONTEXT invariants consolidated to about 15.
15. **Growth chart** — `ahde log`: versions × pass rate × cost, resolved
    failure modes, a human changelog per promotion (old item 16).
    *Landed as `ahde log --target <dir> [--project <id>] [--limit N] [--json]`
    (`src/application/agent-log.ts`, rendered by
    `src/builder/render/agent-log.ts`): a pure read over immutable Candidate
    records, one row per promotion, newest first — tag, date, baseline →
    candidate revision, the development score with its 95% interval, the sealed
    verdict and design size (never a task id or a corpus identity), the cost
    ratio, the failure modes the promotion resolved (modes the source diagnosis
    named whose tasks flipped fail→pass, via `detectPromotionFlips` and the
    brief), the operator's reason, and `applied by the improvement loop` when
    the apply receipt says so. Rejections are dimmed rows between the
    promotions, and under them a bounded sparkline of development score per
    version plus the cumulative cost. The same projection is the HTML report's
    optional Growth section whenever a project is known.*
16. **Model comparison mode** and **`ahde watch`** (old items 13, 14) as the
    platform demands.
    *`ahde watch` landed (`src/application/watch.ts`,
    `src/builder/render/watch.ts`): each tick runs the basket against the ACTIVE
    revision as ordinary development evidence (`solo`, never a candidate arm)
    and compares it with the previous tick of that revision through
    `compareEvalRuns` in exploratory mode — an A/A pair. `inconclusive` is
    healthy; `regressed` on an unchanged revision is **drift** somewhere below
    the harness boundary, and `improved` is drift too, reported as such rather
    than as a win. The score alone does not pretend to distinguish a provider
    rollout from stochastic, runtime, tool, or external-data changes. A
    calibration of that exact revision puts its
    flip rate beside the verdict; without one the line says `noise not
    calibrated` and points at `ahde calibrate`. `--once` exits 0 healthy /
    3 drift / 2 no comparable baseline; `--every 30s|5m|2h|1d` loops on a
    monotonic timer until SIGINT, bounded by `--max-runs`. Nothing new is
    stored — the previous tick is found by scanning eval-run indexes, screens
    excluded by their durable markers — and a drift changes no durable state
    beyond the eval run its tick produced. Model comparison mode is still open.*

## Owner-only items (nothing else depends on the code)

- **Two or three real Targets.** 30–50 real cases each with what a correct
  answer looks like, plus 15–20 sealed cases the Builder never sees. Any file
  in `imports/` — CSV, JSON, chat export. Until then every wave is verified on
  the ombudsman toy graders.
- **Builder model.** `ahde` → `/login` → `/model` on a frontier model; the
  Target stays cheap. `~/.ahde` currently has no default model and no
  provider login.
- **Merging `v2-measurement` into master.**

## Definition of done for V2

On two or three real agents: at least one promotion on judge-graded tasks
with measured judge agreement above the threshold; a "change → verdict" cycle
an order of magnitude cheaper than a full verification thanks to the cheap
check and regrade; three promoted cycles without a sealed regression and with
cumulative gains; the platform drives the loop headlessly with its own
confirmation UI.

## Non-goals (with reasons)

- New artifact or receipt types (the audit chain is complete; add screens,
  not schemas).
- Features beyond this list before real Targets exist.
- RL or weight updates (Agent Lightning's territory).
- A web UI inside AHDE (the platform owns the UI).
- Semantic failure clustering as *evidence* — hypotheses to choose what to
  fix, never promotion evidence (invariant 29).
- Windows.

## Stand on Pi (checked against 0.84.4, 2026-08-28)

Reuse before writing: `packages/evals` + `vitest-evals` (`createPiCodingAgentHarness`,
`evalHarnessTable` baseline/candidate with repetitions, judges) for grader
shapes and model comparison; the session tree (`appendMessage`, branching)
for dialogue cases and alternative proposals; `--mode rpc` / `-p` / JSON for
headless Builder and CI; Gondolin / Docker / OpenShell for Target isolation;
`examples/extensions` (sandbox, subagent, permission-gate, protected-paths,
questionnaire, structured-output) for the Builder's hands and gates.

Earendil radar: Pi's core stays MIT with Fair Source and enterprise tiers;
evals and server features are the natural paid lane. Track `packages/evals`
and the `pi-review-loop` extension; keep AHDE's graders in a shape that can
wrap Pi's judges; pin Pi upgrades (0.84.4 changes nothing AHDE depends on).

## Appendix — where the V1.9 items went

| Old | Item | Now |
|---|---|---|
| 0 | dialogue cases | landed (V1.9); simulated user → wave 2 (#10) |
| 0b | any data → benchmark | landed (V1.9) |
| 0c | tool workshop | core landed; Builder surface → wave 2 (#9) |
| 1 | feedback becomes tests | landed (marks); `feedback import` folded into any-data |
| 2 | autoloop | wave 2 (#7) |
| 3 | sealed holdout without pain | wave 2 (#11) |
| 4 | promoted fixes become guards | wave 2 (#8) |
| 5 | labeling in the Evidence Explorer | wave 1 `ahde label` (CLI first); browser later |
| 6 | judge reliability | wave 1 (#3) |
| 7 | semantic failure modes | non-goal as evidence; hypotheses only |
| 8 | search, not one guess | wave 2 (#6) |
| 9 | partial credit | wave 1 (#2) |
| 10 | richer declarative graders | after real Targets show which checks are missing |
| 11 | cost and latency in the verdict | wave 1 (#2) |
| 12 | safety basket | after real Targets |
| 13, 14 | model comparison, `ahde watch` | wave 3 (#16) |
| 15 | cost/time forecast before confirming | wave 1 (#4, cost guard) |
| 16 | growth chart | wave 3 (#15) |
| 17 | trace in the terminal | with `ahde label` (wave 1 shows the answer inline) |
| 18 | import an existing agent | any-data + `ahde init` cover most of it; revisit |
| 19 | cheap check | wave 2 (#5) |
| 20 | coverage map | after real Targets |
| 21 | promotion as a PR; evals in CI | wave 3, with headless mode |
| 22 | ideal answer as grader | reference graders landed (V1.9); the Builder drafting the answer → with #9 |
| 23 | bisect on drift | after `ahde watch` |
