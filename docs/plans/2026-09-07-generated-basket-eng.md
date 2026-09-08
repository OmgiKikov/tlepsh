# Generated development basket: engineering review

Date: 2026-09-07. Branch: `codex/product-wow`, HEAD `55ed6e5` plus the existing operator-owned working changes. Skill: `gstack/plan-eng-review`, read in full, orchestrator-spawned mode. Scope: planning only; no source edits or test execution in this review.

## Step 0: scope challenge

The feature is a better authoring flow inside AHDE, not a new generator service. Builder Pi already writes cases, Workbench already validates and stores an immutable editable draft, and `run-current` already takes the human through publication and the first run. Reuse all three.

Recommended scope: public context → useful generated cases → readable review and revision → the existing exact publication/run. Include the difficult cases of that path: unknown rules, unavailable documents, dialogue state isolation, cancellation, and stale review. Do not add an independent generation job, another model configuration, a wizard, or another case store.

The complete vertical change will probably touch more than eight files because the model-facing contract, host projection and terminal renderer are intentionally separate. This is an integration cost, not a reason to merge their authority. Keep at most one new small validation module and zero new services/classes. The three requested independent reviews supply the outside voices; no fourth agent is necessary.

No new architecture, dependency or concurrency pattern is proposed, so no external framework research is needed for these decisions. This review does not make a claim that a model or library is the latest available. The existing August product-shell design explicitly favors this same bounded Builder/Workbench boundary. No root AGENTS.md, CLAUDE.md or TODOS.md exists.

## What already exists

| Need | Existing seam | Decision |
|---|---|---|
| Read an agreed purpose, constraints and unknowns | `src/spec.ts`: `AgentSpecSchema`, `loadApprovedSpec` | Reuse exact approved snapshot, including `openQuestions` |
| Read agent instructions, skills, tools and prompt files | `src/application/target-authoring-context.ts`: `inspectTargetAuthoringContext` | Reuse exact clean Git context and host-minted claim |
| Write generated cases | `src/application/builder-corpus-draft.ts`: `createBuilderCorpusDraft` | Reuse; Builder Pi authors tasks, host derives IDs |
| Edit/add/remove/regrade cases | `reviseBuilderCorpusDraft`, `corpus-revision` | Reuse immutable child drafts, never edit a published corpus |
| Validate tool names, graders and evaluator prerequisites | `src/application/corpus-target.ts`, Workbench submit/publication | Keep validation at shared boundaries |
| Simulate dialogue and per-run state | `SimulatedUserSpecSchema`, `WorldSchema`, `src/simulated-user.ts` | Keep one runtime; user facts stay separate from backend-only world |
| Show a case | `datasetCasePreview` → `renderDatasetCases` | Extend the shared card instead of creating a generator-only preview |
| Review/publish/run | `run-current` → `start-testing`, `testingConsent`, `decidePublishCorpus` | Reuse the exact human gate, stale checks, evaluator setup and receipts |
| Freeze corpus | `recordWorkbenchCorpusPublication` | Reuse; it checks `hashValue(draft.tasks) === publication.corpus.hash` |
| KB chunking, search and citations | `src/domain/kb.ts`, `src/target/kb-tool.ts` | Reuse deterministic chunks; do not reuse sealed-exam generation |

## Architecture review

1. **[P1, confidence 9/10] Reading agent documents is not reading its KB.** `target-authoring-context.ts:114` says: `Declared data is shape, never content`; its resource kinds exclude data documents. The current target view gives names and sizes of `data/**`, so Builder cannot derive a RAG answer from those names. Recommended 1A: expose bounded reads/search of declared public KB text through the existing exact target context. Keep the exact Git revision and current denial rules; support the already-supported `.md`/`.txt` formats only. Do not simply call `readKnowledgeBase(target.dir)` on the ambient working tree and call the result an exact Git snapshot. Alternative 1B, claiming KB grounding without those reads, is unacceptable.

2. **[P1, confidence 9/10] “Spec-bound” currently means identity, not grounded business expectations.** `builder-corpus-draft.ts:55` is `expected: TaskSchema.shape.expected`; `:64` requires graders, but neither validates the origin of an asserted fact. A model can save “refund within 30 days” even when the Spec leaves that rule unknown. Recommended 2A: keep generation provenance and unresolved rules visible in the existing draft, validate source references against the exact approved Spec/public resources, and require unresolved case expectations to be resolved or removed before publication. A source reference proves which bytes were read, not that the generated interpretation is correct; the human still reviews the meaning. Do not add another LLM “truth verifier”. Existing manual/imported drafts remain readable.

   Minimum representation: one bounded optional generated-draft section on the current artifact, containing the exact source claim, case-to-source references and unresolved questions. Keep it outside executable Task fields unless it needs to travel with published cases; do not serialize an opaque JSON protocol inside a free-text coverage note. Hash any new authoritative content and explicitly version the draft schema if the stored shape changes. No separate receipt database is needed. Existing publication already hashes the complete reviewed draft and the exact task array.

3. **[P1, confidence 9/10] Known user facts are currently mixed into persona/goal prose.** `manifest.ts:299` declares only `goal`, optional `persona`, `maxTurns`, and optional `stopWhen`; `simulated-user.ts` deliberately withholds the whole world and says user facts belong in goal/persona. Recommended 3A: preserve this trust boundary. If the unified review needs a separately labeled known-facts field, add one optional bounded field to `SimulatedUserSpecSchema`, use it in the simulator prompt, and carry it through the existing preview/hash paths. Never infer “known to the user” by copying `world.state`. Alternative 3B, exposing the complete world to simulate better dialogue, invalidates the eval.

4. **[P2, confidence 9/10] The product instruction underspecifies the no-basket route.** `next-actions.ts:114` only says `write the first Spec-bound cases, each with at least one grader`; `builders/ahde/AGENTS.md:241` starts `Write the tests. Start small, from realistic tasks`. Recommended 4A: explicitly route “no basket / generate checks” to inspect approved purpose and available sources, generate a compact draft, explain coverage and open questions, revise it in conversation, then request the existing `run-current`. No “put a file in imports” requirement when the user has no file. Use 6–10 cases by default, adjust to the agent, and never force irrelevant categories merely to reach a quota.

## Code quality review

5. **[P1, confidence 9/10] World case cards hide parts of the reviewed case.** `render/view.ts:1237–1243` returns only title, who, has, wants and must. That branch does not render the task's `expected`, dialogue stop condition or metadata; the non-world branch does render expected/metadata. Generated stateful cases therefore need the same source/expectation visibility as single-turn cases. Recommended 5A: a shared compact detail block used by both card branches, with input, expected behavior, grader, simulator-known facts, world and source as applicable. Make omitted detail inspectable. Do not duplicate the preview model in a new screen.

6. **[P2, confidence 8/10] A second generation API would reproduce existing validation and decisions.** The actual submit path at `workbench.ts:3080` already loads the exact approved Spec, validates graders, calls `createCorpusDraft`, selects the artifact and returns the new view. Recommended 6A: extend that boundary and its schema; put any nontrivial grounding validation in the draft application layer. Do not append another 300-line branch to Workbench or fork the import path. The existing revision path must preserve/update/drop grounding for changed task IDs, just as failure provenance already does.

## Selected flow and data boundary

```text
"Нет корзины, придумай проверки"
             |
             v
 Builder Pi reads approved Spec + target context
             |                     |
             |                     +--> declared public resources / KB only
             |                          exact revision, bounded reads
             v
 cases + expected behavior + graders + source references
 optional dialogue: goal + known facts      optional world: tools' backend state
             |
             v
 corpus-draft validation
   bad source / tool / schema --> readable rejection, no draft write
   unknown business rule -----> visible question; no fabricated expectation
             |
             v
 existing case cards <------> corpus-revision (new immutable child)
             |
             v
 run-current -> one exact review + evaluator configuration when needed
   cancel / source stale / unresolved assertion -> no publish and no run
             |
             v
 existing publication -> immutable cases -> baseline -> traces
             |
             +--> later candidate uses that same corpus identity
```

Unknowns that are merely outside the chosen test scope should be visible coverage gaps, not a blanket prohibition on testing the known part. Unknowns used by a case's expected behavior must block that case's publication. Distinguish those two states in the generated-draft contract; do not require all `Spec.openQuestions` to be answered to run any test.

## Test review

Framework: existing TypeScript + Vitest. New tests belong in its current suites. Existing tests already cover draft identity, duplicate content, immutable revisions, invalid graders, absent evaluator models, publication lineage, composite staleness, and simulated-user world/reference isolation. Scripted mock-model tests prove orchestration, not real model quality.

```text
PATH                                                  COVERAGE / REQUIRED ACCEPTANCE
draft creation/revision/hash                            existing builder-corpus-draft tests
invalid grader / missing model                          existing workbench-corpus-validation tests
public declared target read                             existing context-authoring tests
  KB read from exact committed bytes                    GAP: dirty/stale/path escape/symlink/size bounds
  private/eval/imports/undeclared path                    retain denial tests, add KB sibling regression
grounded generated draft                                GAP: real source accepted; invented/stale ref refused
  unresolved case expectation                           GAP: question visible; no publication/run
  unknown outside selected scope                        GAP: can publish reviewed known subset
revision changes a grounded task                         GAP: sources remap or become unresolved, old draft unchanged
world and ordinary cards                                GAP: same expected/source/known-facts visibility
simulated user known facts                               GAP if field added: receives known fact, not world/ref/grader
natural words -> Builder tools -> draft -> edit -> test  GAP [E2E]: public registered tools and real receipts
  abort before review / decline / double submit          GAP [E2E]: no effects or idempotent existing effects
  change target/Spec while dialog open                    retain composite tests + generated-source staleness
prompt quality                                          GAP [EVAL]: live Builder on RAG and stateful Python fixture
```

Acceptance fixtures should include: a sourced answer; absent KB answer; an unsupported/refused request; tool success; declared tool failure; and one clarification dialogue with known account ID but private backend status. Include only cases justified by that fixture's Spec and capabilities. An infrastructure timeout is not an agent-behavior failure.

The critical integration test must call registered Builder tools through the real Pi/Workbench adapter, record the human review subject, revise one generated case, approve `run-current`, and assert that published task bytes and the baseline dataset hash match the revised reviewed basket. Assert the original target checkout was not modified by basket authoring. Use the existing mock HTTP model only at provider endpoints. Do not stub the draft writer, publication or evaluation to “pass”.

Live acceptance: run AHDE with the existing real configured Builder on a temporary ready Python agent, say “корзины нет, сгенерируй проверки”, inspect all generated cards, request a concrete correction, then run. Record the exact models, resulting draft/corpus IDs, one trace and the unknown-rule handling. Run a second small RAG fixture with public `.md` sources. No customer agent has arrived; these runs demonstrate the product path on fixtures, not client adoption or quality superiority.

Suggested verification after implementation: `npx tsc -p tsconfig.test.json`; focused corpus/context/render/simulator/new flow suites; `npm run acceptance:guided`; `npm run verify:package`. Avoid duplicating the whole pilot matrix when the targeted and guided suites already exercise unchanged mechanics; broaden only for a discovered failure.

## Performance review

7. **[P2, confidence 9/10] Full KB prompt dumps would turn generation into unbounded context work.** Existing limits in `target-authoring-context.ts` cap resource text at 512 KiB and aggregate context at 8 MiB; KB chunk/search already supplies deterministic bounded retrieval. Recommended 7A: resource listing followed by bounded relevant document/chunk reads, with explicit omitted counts. Do not add a cache, index service or embedding call. Preserve the 100-task draft hard cap and use a small initial default. Builder generation uses the existing session's spend and cancellation handling; draft generation itself must not run the Target or the tools.

## Failure modes and recovery

| Failure | Handling / what the human sees | Check |
|---|---|---|
| Missing or unsupported KB | State exactly what was unreadable; author only justified cases and visible gaps | Context + live fixture |
| Invented rule/source | Invalid reference refused; unknown assertion remains a review question | Draft/publication integration |
| Model emits wrong tool/state schema | Existing host validation before persistence, readable correction | Grader/tool contract test |
| Builder interrupted while generating | Previous immutable draft remains; incomplete generation is not a published basket | Provider cancellation + flow test |
| Target/Spec changes after generation/review | Re-read source claim and exact review subject, refuse stale publication | Staleness integration |
| Revision changes task content | New task/draft hash and updated grounding, old published baseline unchanged | Revision/publication test |
| Simulator learns private state | Keep world/reference/graders out of prompt; optional known-facts only | Captured evaluator request test |
| Preview hides important details | Both card branches display same semantics; complete details remain inspectable | Terminal renderer test |

Two critical silent gaps in the current proposed experience: unsupported expectations can look authoritative, and stateful cards hide reviewed details. The plan closes both before release.

## Implementation Tasks

- [ ] **T1 (P1, human ~1 day / agent ~45 min)**: application context and draft contracts. Extend exact public KB reading and the existing generated-draft source/unknown-rule validation. Reuse publication, hashes and revisions. Verify context boundary and generated-draft integration tests.
- [ ] **T2 (P1, human ~0.5 day / agent ~25 min)**: conversational route and review. Update `builders/ahde/AGENTS.md`, `next-actions.ts`, tool descriptions and the shared case card. Ensure generated provenance/unknowns survive view projection. Verify registered tool and terminal renderer tests.
- [ ] **T3 (P1, human ~0.5 day / agent ~20 min)**: explicit known-facts handling if the product uses a separate field. Change canonical simulator schema, prompt and the existing case projection; keep old absent-field hashes stable. Verify a captured user-model request contains the public fact but no backend secret/reference/grader.
- [ ] **T4 (P1, human ~1 day / agent ~45 min)**: complete no-basket integration and live acceptance. Run genuine draft → correction → reviewed publication → baseline through AHDE, with negative branches. Save measured evidence and accurately separate mock orchestration proof from live model quality.

Implementation order: T1 contract first; T2 presentation/instructions and T3 simulator can proceed after those field decisions, with a single owner for shared `types.ts`/`workbench.ts`/render edits. T4 starts once integrated. Existing dirty changes are preserved, not reset or rewritten. No worktree/branch mutation is part of this review.

## NOT in scope

- A separate generation runtime, service, job queue, model picker or “studio”: Builder Pi and existing AHDE flow cover the request.
- Training a classifier, optimizing prompts automatically, or rewriting scoring: these are separate later steps using the generated frozen corpus.
- Sealed-exam generation or publishing generated development cases as independent holdout evidence: different trust boundary and product claim.
- Arbitrary PDFs, remote document crawlers or embeddings: existing `.md`/`.txt` public KB is sufficient; unsupported inputs are named honestly.
- A new graph of sources or generic rule engine: exact bounded references and reviewed expectations cover this feature.
- Broad Workbench refactoring or unrelated first-build repair: preserve current user changes and flag separately if they actually block this flow.

No standalone TODOS.md changes are proposed; deferred items are intentionally out of this feature rather than promised follow-ups.

## Completion summary

Status: DONE_WITH_CONCERNS. Scope accepted with reuse; architecture 4 findings, code quality 2, performance 1; test diagram and failure matrix produced. No source edits; tests/live generation not run by this planning agent. Two current critical experience gaps are covered by the proposed P1 work. No unresolved choice requiring the user; parent combines the requested three reviews and selects the final field contract. Outside voice: parallel requested reviewers, not rerun here. Lake score: complete feature boundaries selected, speculative adjacent systems excluded.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| Eng Review | `plan-eng-review` | Generated basket plan | 1 | PLAN COMPLETE; IMPLEMENTATION OPEN | 7 source-grounded findings, 2 critical experience gaps |
| Architecture Review | Requested parallel reviewer | Module boundaries | — | Parent aggregates | Separate artifact |
| Code Quality Review | Requested parallel reviewer | Minimal maintainable change | — | Parent aggregates | Separate artifact |

UNRESOLVED: 0 user decisions; implementation and its acceptance remain open.

VERDICT: engineering plan ready to combine and implement; this is not release clearance or evidence of live feature completion.
